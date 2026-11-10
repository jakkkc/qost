-- Qost 0007: sales import, kitchen counts and the leakage reports. Run after 0006.

-- ---------- Import batches also cover sales and counts ----------
alter table import_batches drop constraint import_batches_kind_check;
alter table import_batches add constraint import_batches_kind_check
  check (kind in ('purchases','issues','opening','sales','counts'));

-- ---------- Sales ----------
alter table sales_imports add column batch_id uuid references import_batches(id) on delete cascade;
alter table sales_lines add column unit_price_original numeric;
alter table sales_lines add column pax_override numeric;           -- package lines: guests served, if different from sold qty
alter table package_sales add column sales_import_id uuid;          -- reserved; imported package pax come from sales_lines
alter table stock_counts add column batch_id uuid references import_batches(id) on delete cascade;

-- Editing a unit price or quantity recalculates the line (gross = price x qty, net = gross / tax factor).
create function sales_line_recalc() returns trigger language plpgsql as $$
declare tf numeric;
begin
  if new.unit_price is distinct from old.unit_price or new.sold_qty is distinct from old.sold_qty then
    select tax_factor into tf from tenant_settings where tenant_id = new.tenant_id;
    new.gross_total := coalesce(new.unit_price, 0) * new.sold_qty;
    new.net_sales := new.gross_total / coalesce(tf, 1);
  end if;
  return new;
end $$;
create trigger sales_lines_recalc before update on sales_lines for each row execute function sales_line_recalc();
create trigger audit_sales_lines after update on sales_lines for each row execute function audit_row();

-- ---------- One primary dish per POS item ----------
alter table pos_item_links add column is_primary boolean not null default false;
update pos_item_links set is_primary = true
where id in (select distinct on (pos_item_id) id from pos_item_links order by pos_item_id, id);

create function pos_link_primary_default() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from pos_item_links where pos_item_id = new.pos_item_id and is_primary) then
    new.is_primary := true;
  end if;
  return new;
end $$;
create trigger pos_item_links_primary before insert on pos_item_links for each row execute function pos_link_primary_default();
create unique index pos_item_links_one_primary on pos_item_links (pos_item_id) where is_primary;

create function set_primary_link(p_link uuid) returns void language plpgsql security invoker as $$
declare pid uuid;
begin
  select pos_item_id into pid from pos_item_links where id = p_link;
  if pid is null then raise exception 'link not found'; end if;
  update pos_item_links set is_primary = false where pos_item_id = pid and is_primary;
  update pos_item_links set is_primary = true where id = p_link;
end $$;

-- ---------- Import sales ----------
-- p_rows: [{code,name,source,group,unit_price,qty,gross,account,tax_total,net}]
-- Refuses a range that overlaps an earlier, still-active import for the same branch unless p_allow_overlap.
create function import_sales(p_file text, p_branch text, p_from date, p_to date, p_rows jsonb, p_allow_overlap boolean default false)
returns jsonb language plpgsql security invoker as $$
declare t uuid := my_tenant(); b uuid; sid uuid; r jsonb; n int := 0; unknown int := 0; unlinked int := 0; overlap int;
begin
  if t is null then raise exception 'no tenant'; end if;
  if p_to < p_from then raise exception 'end date is before start date'; end if;
  select count(*) into overlap from sales_imports s join import_batches ib on ib.id = s.batch_id
    where s.tenant_id = t and s.branch = p_branch and ib.reversed_at is null and s.date_from <= p_to and s.date_to >= p_from;
  if overlap > 0 and not p_allow_overlap then
    raise exception 'OVERLAP: % earlier sales import(s) for % already cover part of % to %', overlap, p_branch, p_from, p_to;
  end if;
  insert into import_batches (tenant_id, kind, file_name) values (t,'sales',p_file) returning id into b;
  insert into sales_imports (tenant_id, branch, date_from, date_to, file_name, batch_id) values (t,p_branch,p_from,p_to,p_file,b) returning id into sid;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into sales_lines (tenant_id,import_id,pos_code,pos_name,item_source,group_name,unit_price,unit_price_original,sold_qty,gross_total,income_account,tax_total,net_sales)
    values (t,sid,(r->>'code')::int,r->>'name',r->>'source',r->>'group',nullif(r->>'unit_price','')::numeric,nullif(r->>'unit_price','')::numeric,
            (r->>'qty')::numeric,nullif(r->>'gross','')::numeric,r->>'account',nullif(r->>'tax_total','')::numeric,nullif(r->>'net','')::numeric);
    n := n + 1;
  end loop;
  select count(distinct l.pos_code) into unknown from sales_lines l
    where l.import_id = sid and not exists (select 1 from pos_items p where p.tenant_id = t and p.pos_code = l.pos_code);
  select count(distinct l.pos_code) into unlinked from sales_lines l join pos_items p on p.tenant_id = t and p.pos_code = l.pos_code
    where l.import_id = sid and not exists (select 1 from pos_item_links k where k.pos_item_id = p.id);
  update import_batches set row_count = n where id = b;
  return jsonb_build_object('batch', b, 'import', sid, 'inserted', n, 'unknown_pos', unknown, 'unlinked_pos', unlinked);
end $$;

-- ---------- Import / save kitchen counts ----------
-- p_rows: [{name, qty}] ingredient names as in the workbook. One count per location, item and date (a re-import updates it).
create function import_counts(p_file text, p_location uuid, p_date date, p_rows jsonb)
returns jsonb language plpgsql security invoker as $$
declare t uuid := my_tenant(); b uuid; r jsonb; iid uuid; ins int := 0; upd int := 0; unknown text[] := '{}'; existed boolean;
begin
  if t is null then raise exception 'no tenant'; end if;
  insert into import_batches (tenant_id, kind, file_name) values (t,'counts',p_file) returning id into b;
  for r in select * from jsonb_array_elements(p_rows) loop
    select id into iid from items where tenant_id = t and lower(name) = lower(trim(r->>'name'));
    if iid is null then unknown := unknown || (r->>'name'); continue; end if;
    select exists (select 1 from stock_counts where tenant_id = t and location_id = p_location and item_id = iid and count_date = p_date) into existed;
    insert into stock_counts (tenant_id, location_id, item_id, count_date, qty, batch_id)
    values (t, p_location, iid, p_date, (r->>'qty')::numeric, b)
    on conflict (tenant_id, location_id, item_id, count_date) do update set qty = excluded.qty, batch_id = excluded.batch_id;
    if existed then upd := upd + 1; else ins := ins + 1; end if;
  end loop;
  update import_batches set row_count = ins + upd where id = b;
  return jsonb_build_object('batch', b, 'inserted', ins, 'updated', upd, 'unknown', to_jsonb(unknown));
end $$;

-- Reversing a sales or counts batch removes its rows (they are not ledger entries).
create or replace function reverse_batch(p_batch uuid) returns int language plpgsql security invoker as $$
declare t uuid := my_tenant(); b import_batches; m stock_movements; n int := 0; iid uuid;
begin
  select * into b from import_batches where id = p_batch and tenant_id = t;
  if not found then raise exception 'batch not found'; end if;
  if b.reversed_at is not null then raise exception 'batch already reversed'; end if;
  if b.kind = 'sales' then
    delete from sales_imports where batch_id = p_batch;
  elsif b.kind = 'counts' then
    delete from stock_counts where batch_id = p_batch;
  else
    for m in select * from stock_movements
             where batch_id = p_batch and reversal_of is null and kind <> 'reversal'
               and not exists (select 1 from stock_movements x where x.reversal_of = stock_movements.id) loop
      insert into stock_movements (tenant_id,item_id,alias_id,location_id,movement_date,kind,qty,unit_cost,ref_no,transfer_id,note,reversal_of)
      values (t,m.item_id,m.alias_id,m.location_id,m.movement_date,'reversal',-m.qty,m.unit_cost,m.ref_no,m.transfer_id,'batch reversed',m.id);
      n := n + 1;
    end loop;
    if b.kind = 'purchases' then
      for iid in select distinct item_id from grn_lines where batch_id = p_batch loop
        delete from grn_lines where batch_id = p_batch and item_id = iid;
        update items i set
          unit_cost    = (select g.unit_cost_ing from grn_lines g where g.item_id = iid order by g.purchase_date desc, g.created_at desc limit 1),
          unit_cost_at = (select g.purchase_date from grn_lines g where g.item_id = iid order by g.purchase_date desc, g.created_at desc limit 1)
        where i.id = iid;
      end loop;
    end if;
  end if;
  update import_batches set reversed_at = now() where id = p_batch;
  return n;
end $$;

-- ---------- Report building blocks ----------
-- Everything sold in the period: dishes (primary POS link) and packages (pax). Imports count when their whole
-- date range lies inside the period. Manual package pax rows count by their date.
create function period_sales(p_branch text, p_from date, p_to date)
returns table (recipe_id uuid, package_id uuid, qty numeric) language sql stable security invoker as $$
  select k.recipe_id, k.package_id,
         sum(case when k.package_id is not null then coalesce(l.pax_override, l.sold_qty) else l.sold_qty end)
  from sales_lines l
  join sales_imports s on s.id = l.import_id
  join import_batches ib on ib.id = s.batch_id and ib.reversed_at is null
  join pos_items p on p.tenant_id = l.tenant_id and p.pos_code = l.pos_code
  join pos_item_links k on k.pos_item_id = p.id and k.is_primary
  where s.branch = p_branch and s.date_from >= p_from and s.date_to <= p_to
  group by k.recipe_id, k.package_id
  union all
  select null::uuid, ps.package_id, sum(ps.pax)
  from package_sales ps
  where ps.branch = p_branch and ps.sale_date between p_from and p_to and ps.sales_import_id is null
  group by ps.package_id
$$;

-- What the recipes say the kitchen should have used, broken down by the dish that drives each ingredient.
create function usage_should(p_branch text, p_from date, p_to date)
returns table (item_id uuid, recipe_id uuid, qty numeric) language sql stable security invoker as $$
  with sales as (select s.recipe_id, s.package_id, sum(s.qty) as qty from period_sales(p_branch, p_from, p_to) s group by s.recipe_id, s.package_id),
  dish_portions as (   -- portions of each dish served: sold directly + inside packages
    select recipe_id, sum(qty) as portions from (
      select s.recipe_id, s.qty from sales s where s.recipe_id is not null
      union all
      select pl.recipe_id, s.qty * pl.qty_per_pax from sales s join package_lines pl on pl.package_id = s.package_id where s.package_id is not null and pl.recipe_id is not null
    ) x group by recipe_id
  )
  select rl.item_id, dp.recipe_id, sum(rl.qty * dp.portions)
  from dish_portions dp join recipe_lines rl on rl.recipe_id = dp.recipe_id
  group by rl.item_id, dp.recipe_id
  union all   -- raw ingredients listed directly on a package
  select pl.item_id, null::uuid, sum(s.qty * pl.qty_per_pax)
  from sales s join package_lines pl on pl.package_id = s.package_id
  where s.package_id is not null and pl.item_id is not null
  group by pl.item_id
$$;

-- Latest count on or before a date (null if none). Blank counts are treated as 0 by the callers, like the workbook.
create function count_at(p_loc uuid, p_item uuid, p_date date) returns numeric language sql stable security invoker as $$
  select qty from stock_counts where location_id = p_loc and item_id = p_item and count_date <= p_date
  order by count_date desc limit 1
$$;

create function branch_kitchen(p_branch text) returns uuid language sql stable security invoker as $$
  select id from locations where branch = p_branch and kind = 'kitchen' order by name limit 1
$$;

-- ---------- Kitchen usage vs recipes ----------
create function kitchen_usage(p_branch text, p_from date, p_to date)
returns table (item_id uuid, item_name text, unit text, unit_cost numeric, opening numeric, issued numeric, closing numeric,
               actual_used numeric, should_used numeric, variance_qty numeric, variance_kes numeric, variance_pct numeric, flag text)
language sql stable security invoker as $$
  with k as (select branch_kitchen(p_branch) as loc),
  allowed as (select coalesce((select variance_allowed from tenant_settings limit 1), 0.05) as v),
  should as (select u.item_id, sum(u.qty) as q from usage_should(p_branch, p_from, p_to) u group by u.item_id),
  issued as (
    select m.item_id, sum(m.qty) as q from stock_movements m, k
    where m.location_id = k.loc and m.kind = 'issue_in' and m.movement_date between p_from and p_to
      and not exists (select 1 from stock_movements x where x.reversal_of = m.id)
    group by m.item_id
  ),
  items_involved as (
    select item_id from should union select item_id from issued
    union select c.item_id from stock_counts c, k where c.location_id = k.loc and c.count_date between p_from and p_to
  ),
  calc as (
    select i.id as item_id, i.name, i.unit, i.unit_cost,
           coalesce(count_at(k.loc, i.id, p_from), 0) as opening,
           coalesce(iss.q, 0) as issued,
           coalesce(count_at(k.loc, i.id, p_to), 0) as closing,
           coalesce(sh.q, 0) as should_used
    from items_involved ii join items i on i.id = ii.item_id cross join k
    left join issued iss on iss.item_id = i.id left join should sh on sh.item_id = i.id
  )
  select c.item_id, c.name, c.unit, c.unit_cost, c.opening, c.issued, c.closing,
         c.opening + c.issued - c.closing as actual_used, c.should_used,
         (c.opening + c.issued - c.closing) - c.should_used as variance_qty,
         ((c.opening + c.issued - c.closing) - c.should_used) * coalesce(c.unit_cost, 0) as variance_kes,
         case when (c.opening + c.issued - c.closing) = 0 then null
              else ((c.opening + c.issued - c.closing) - c.should_used) / (c.opening + c.issued - c.closing) end as variance_pct,
         case when (c.opening + c.issued - c.closing) > 0 and c.should_used = 0 then 'No recipe uses it'
              when (c.opening + c.issued - c.closing) = 0 then ''
              when ((c.opening + c.issued - c.closing) - c.should_used) / (c.opening + c.issued - c.closing) > a.v then 'Missing / over-used'
              when ((c.opening + c.issued - c.closing) - c.should_used) / (c.opening + c.issued - c.closing) < -a.v then 'Under-portioned?'
              else 'OK' end
  from calc c cross join allowed a
  order by c.name
$$;

-- ---------- Expected sales from the key ingredient ----------
create function expected_sales(p_branch text, p_from date, p_to date)
returns table (recipe_id uuid, dish text, menu_price numeric, key_item text, key_qty numeric, used_for_dish numeric,
               sold numeric, package_portions numeric, portions_expected numeric, expected_sales numeric, actual_sales numeric, sales_gap numeric)
language sql stable security invoker as $$
  with ku as (select * from kitchen_usage(p_branch, p_from, p_to)),
  ps as (select s.recipe_id, s.package_id, sum(s.qty) as qty from period_sales(p_branch, p_from, p_to) s group by s.recipe_id, s.package_id),
  sold as (select recipe_id, sum(qty) as q from ps where recipe_id is not null group by recipe_id),
  pkg as (
    select pl.recipe_id, sum(ps.qty * pl.qty_per_pax) as q
    from ps join package_lines pl on pl.package_id = ps.package_id
    where ps.package_id is not null and pl.recipe_id is not null group by pl.recipe_id
  ),
  other as (   -- what every OTHER dish and package should have used of each ingredient
    select u.item_id, u.recipe_id as by_recipe, sum(u.qty) as q from usage_should(p_branch, p_from, p_to) u group by u.item_id, u.recipe_id
  ),
  base as (
    select r.id as recipe_id, r.name as dish, r.menu_price, r.key_item_id, i.name as key_item,
           (select sum(rl.qty) from recipe_lines rl where rl.recipe_id = r.id and rl.item_id = r.key_item_id) as key_qty,
           coalesce(so.q, 0) as sold, coalesce(pk.q, 0) as pkg_portions,
           coalesce((select k.actual_used from ku k where k.item_id = r.key_item_id), 0)
             - coalesce((select sum(o.q) from other o where o.item_id = r.key_item_id and o.by_recipe is distinct from r.id), 0) as used_for_dish
    from recipes r join items i on i.id = r.key_item_id
    left join sold so on so.recipe_id = r.id left join pkg pk on pk.recipe_id = r.id
    where r.key_item_id is not null
  )
  select b.recipe_id, b.dish, b.menu_price, b.key_item, b.key_qty, b.used_for_dish, b.sold, b.pkg_portions,
         case when b.key_qty > 0 then floor(b.used_for_dish / b.key_qty) end,
         case when b.key_qty > 0 then floor(b.used_for_dish / b.key_qty) * coalesce(b.menu_price, 0) end,
         b.sold * coalesce(b.menu_price, 0),
         case when b.key_qty > 0 then (floor(b.used_for_dish / b.key_qty) - b.sold - b.pkg_portions) * coalesce(b.menu_price, 0) end
  from base b order by b.dish
$$;

-- ---------- Store stock vs par levels ----------
create view store_reorder with (security_invoker = true) as
select p.tenant_id, p.item_id, i.name as item_name, i.unit, p.location_id, l.branch, l.name as location_name,
       coalesce(b.qty, 0) as balance, p.par_qty, p.reorder_qty,
       case when coalesce(b.qty, 0) < 0 then 'Check entries'
            when coalesce(b.qty, 0) < p.par_qty then 'REORDER' else 'OK' end as flag
from par_levels p
join items i on i.id = p.item_id
join locations l on l.id = p.location_id
left join stock_balances b on b.item_id = p.item_id and b.location_id = p.location_id;

-- ---------- Dashboard (the workbook Summary sheet) ----------
create function dashboard_summary(p_branch text, p_from date, p_to date) returns jsonb
language plpgsql stable security invoker as $$
declare k uuid := branch_kitchen(p_branch); res jsonb;
begin
  select jsonb_build_object(
    'purchases', (select coalesce(sum(total), 0) from grn_lines where purchase_date between p_from and p_to),
    'issues_to_kitchen', (select coalesce(sum(m.qty * coalesce(m.unit_cost, 0)), 0) from stock_movements m
                          where m.location_id = k and m.kind = 'issue_in' and m.movement_date between p_from and p_to
                            and not exists (select 1 from stock_movements x where x.reversal_of = m.id)),
    'stock_value', (select coalesce(sum(b.value), 0) from stock_balances b join locations l on l.id = b.location_id where l.branch = p_branch),
    'actual_sales', (select coalesce(sum(actual_sales), 0) from expected_sales(p_branch, p_from, p_to)),
    'expected_sales', (select coalesce(sum(expected_sales), 0) from expected_sales(p_branch, p_from, p_to)),
    'sales_gap', (select coalesce(sum(sales_gap) filter (where sales_gap > 0), 0) from expected_sales(p_branch, p_from, p_to)),
    'kitchen_variance', (select coalesce(sum(variance_kes) filter (where variance_kes > 0), 0) from kitchen_usage(p_branch, p_from, p_to)),
    'items_to_reorder', (select count(*) from store_reorder r join locations l on l.id = r.location_id where l.branch = p_branch and r.flag = 'REORDER'),
    'dishes_no_recipe', (select count(*) from recipe_costs where on_menu and flag = 'No recipe'),
    'dishes_above_target', (select count(*) from recipe_costs where on_menu and flag = 'Above target cost'),
    'items_variance_above_limit', (select count(*) from kitchen_usage(p_branch, p_from, p_to) where flag = 'Missing / over-used'),
    'package_revenue', (select coalesce(sum(s.qty * pc.price_per_pax), 0) from period_sales(p_branch, p_from, p_to) s join package_costs pc on pc.package_id = s.package_id where s.package_id is not null),
    'package_cost', (select coalesce(sum(s.qty * pc.cost_per_pax), 0) from period_sales(p_branch, p_from, p_to) s join package_costs pc on pc.package_id = s.package_id where s.package_id is not null),
    'packages_not_ok', (select count(*) from package_costs where flag <> 'OK')
  ) into res;
  return res;
end $$;

-- ---------- Key ingredient suggestions: the costliest ingredient per portion ----------
create view key_ingredient_suggestions with (security_invoker = true) as
select distinct on (r.id) r.tenant_id, r.id as recipe_id, r.name as dish, r.key_item_id as current_key_item_id,
       rl.item_id as suggested_item_id, i.name as suggested_item, rl.qty as key_qty, rl.qty * i.unit_cost as line_cost
from recipes r
join recipe_lines rl on rl.recipe_id = r.id
join items i on i.id = rl.item_id and i.unit_cost is not null
order by r.id, rl.qty * i.unit_cost desc, i.name;

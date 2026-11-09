-- Qost 0004: align with the Recipe Cost Control Workbook. Run after 0003_locations.sql.
--
-- items         = the workbook's ingredients (least units), unique by name
-- item_aliases  = system items (code + pack unit) mapped once to an ingredient with a factor
-- recipes       = dishes, quantity per ONE portion; menu price, key ingredient, optional target override
-- packages      = priced per pax; lines are dishes (portions per pax) or ingredients (units per pax)
--
-- This migration expects that no stock data has been imported yet (it reshapes the ledger).

do $$ begin
  if exists (select 1 from stock_movements) or exists (select 1 from grn_lines) then
    raise exception 'Stock data already imported. Reverse all imports first (Purchases / Issues / Opening stock > Reverse), then run this again.';
  end if;
end $$;

drop view if exists stock_balances;
drop view if exists recipe_costs;
drop view if exists price_history;
drop view if exists active_issues;
drop function if exists ensure_item(uuid,int,text,text,text);

-- ---------- Settings ----------
create table tenant_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  tax_factor numeric not null default 1.28 check (tax_factor >= 1),      -- menu price / tax_factor = net price
  target_cost_max numeric not null default 0.40 check (target_cost_max > 0 and target_cost_max < 1),
  variance_allowed numeric not null default 0.05 check (variance_allowed >= 0)
);
insert into tenant_settings (tenant_id) select id from tenants;

-- ---------- Items become ingredients ----------
delete from import_batches;
delete from items;
alter table items drop column last_cost_per_base;
alter table items drop column last_unit_price;
alter table items drop column base_per_purchase_unit;
alter table items drop column base_unit;
alter table items drop column purchase_unit;
alter table items drop column code;
alter table items add column unit text not null default 'g';      -- g, ml, pcs, portion, cup, bunch, packet, leaf, bottle...
alter table items alter column unit drop default;
alter table items add column unit_cost numeric;                    -- latest purchase price per ingredient unit (VAT-inclusive)
alter table items rename column last_cost_at to unit_cost_at;
alter table items add constraint items_tenant_name_key unique (tenant_id, name);

-- ---------- Aliases: system item -> ingredient ----------
create table item_aliases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  system_code integer not null,                 -- 'Item Code' in the internal system
  system_name text not null,
  system_unit text,
  item_id uuid not null references items(id) on delete cascade,
  factor numeric not null check (factor > 0),   -- ingredient units in ONE system unit (1 KGS = 1000 g)
  unique (tenant_id, system_code)
);

-- Rows from imports whose system item has no alias yet. Posted by process_unmapped() once mapped.
create table unmapped_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('purchases','issues','opening')),
  system_code integer not null,
  system_name text,
  system_unit text,
  params jsonb not null,                        -- import parameters (file, locations, mode...)
  row jsonb not null,
  created_at timestamptz not null default now()
);
create index on unmapped_lines (tenant_id, system_code);

-- ---------- Purchases and ledger work in ingredient units ----------
alter table grn_lines add column alias_id uuid not null references item_aliases(id);
alter table grn_lines add column qty_ing numeric not null;           -- quantity in ingredient units
alter table grn_lines add column unit_cost_ing numeric not null;     -- VAT-inclusive price per ingredient unit
alter table grn_lines drop constraint grn_lines_tenant_id_grn_no_item_id_key;
alter table grn_lines add constraint grn_lines_tenant_grn_alias_key unique (tenant_id, grn_no, alias_id);
-- grn_lines.qty and unit_price stay as reported by the system (system units).

alter table stock_movements add column alias_id uuid references item_aliases(id);
-- stock_movements.qty is now in ingredient units; unit_cost is per ingredient unit.

create or replace function apply_grn_cost() returns trigger language plpgsql as $$
begin
  update items set unit_cost = new.unit_cost_ing, unit_cost_at = new.purchase_date
  where id = new.item_id and (unit_cost_at is null or unit_cost_at <= new.purchase_date);
  return new;
end $$;

create view price_history with (security_invoker = true) as
select g.tenant_id, g.item_id, g.purchase_date, g.unit_cost_ing as unit_cost,
       lag(g.unit_cost_ing) over w as previous_cost,
       case when lag(g.unit_cost_ing) over w is not null and g.unit_cost_ing > lag(g.unit_cost_ing) over w
            then round((g.unit_cost_ing / lag(g.unit_cost_ing) over w - 1) * 100, 1) end as increase_pct
from grn_lines g
window w as (partition by g.tenant_id, g.item_id order by g.purchase_date, g.created_at);

create view active_issues with (security_invoker = true) as
select m.tenant_id, m.item_id, m.alias_id, m.ref_no, m.movement_date, m.qty
from stock_movements m
where m.kind = 'issue_in' and m.reversal_of is null
  and not exists (select 1 from stock_movements x where x.reversal_of = m.id);

create view stock_balances with (security_invoker = true) as
select m.tenant_id, m.item_id, m.location_id, sum(m.qty) as qty, i.unit, i.unit_cost,
       sum(m.qty) * i.unit_cost as value
from stock_movements m join items i on i.id = m.item_id
group by m.tenant_id, m.item_id, m.location_id, i.unit, i.unit_cost;

-- ---------- Recipes: dishes, per ONE portion ----------
alter table recipes drop column yield_portions;
alter table recipes rename column selling_price to menu_price;           -- incl. tax
alter table recipes rename column target_cost_pct to target_override;    -- fraction (0.35); null = use the global max
alter table recipes add column on_menu boolean not null default false;
alter table recipes add column key_item_id uuid references items(id);    -- main ingredient used for expected sales
alter table recipe_lines rename column qty_base to qty;                  -- per ONE portion, in the ingredient's unit

-- ---------- Packages: priced per pax ----------
alter table packages drop column kind;
alter table packages rename column selling_price to price_per_pax;       -- incl. tax
alter table package_lines alter column recipe_id drop not null;
alter table package_lines add column item_id uuid references items(id);
alter table package_lines rename column portions to qty_per_pax;         -- portions of a dish, or units of an ingredient
alter table package_lines add constraint package_line_dish_or_item
  check ((recipe_id is not null) <> (item_id is not null));

create table package_sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  package_id uuid not null references packages(id) on delete cascade,
  branch text not null,
  sale_date date not null,
  pax numeric not null check (pax >= 0)
);

-- ---------- POS items ----------
alter table pos_item_map rename to pos_items;
alter table pos_items add column pos_group text;
alter table pos_items add column pos_price numeric;

-- ---------- Counts and par levels ----------
alter table stock_counts rename column counted_qty_base to qty;
alter table par_levels rename column par_qty_base to par_qty;
alter table par_levels rename column reorder_qty_base to reorder_qty;

-- ---------- Costing views ----------
create view recipe_costs with (security_invoker = true) as
with agg as (
  select r.id as recipe_id, count(l.id) as line_count,
         sum(l.qty * coalesce(i.unit_cost, 0)) as cost,
         bool_or(l.id is not null and i.unit_cost is null) as missing_price
  from recipes r
  left join recipe_lines l on l.recipe_id = r.id
  left join items i on i.id = l.item_id
  group by r.id
)
select r.tenant_id, r.id as recipe_id, r.name, r.category, r.on_menu, r.menu_price, r.key_item_id,
       a.cost as cost_per_portion,
       r.menu_price / s.tax_factor as net_price,
       a.cost / nullif(r.menu_price / s.tax_factor, 0) as food_cost,            -- fraction
       coalesce(r.target_override, s.target_cost_max) as target,
       a.cost / coalesce(r.target_override, s.target_cost_max) * s.tax_factor as suggested_price,
       case when a.line_count = 0 then 'No recipe'
            when a.cost = 0 or a.missing_price then 'No price'
            when r.on_menu and r.menu_price is null then 'No menu price'
            when a.cost / nullif(r.menu_price / s.tax_factor, 0) > coalesce(r.target_override, s.target_cost_max) then 'Above target cost'
            else 'OK' end as flag
from recipes r
join agg a on a.recipe_id = r.id
join tenant_settings s on s.tenant_id = r.tenant_id;

create view package_costs with (security_invoker = true) as
with agg as (
  select p.id as package_id, count(l.id) as line_count,
         sum(l.qty_per_pax * coalesce(case when l.recipe_id is not null then rc.cost_per_portion else i.unit_cost end, 0)) as cost,
         bool_or(l.id is not null and coalesce(case when l.recipe_id is not null then rc.cost_per_portion else i.unit_cost end, 0) = 0) as missing_price
  from packages p
  left join package_lines l on l.package_id = p.id
  left join recipe_costs rc on rc.recipe_id = l.recipe_id
  left join items i on i.id = l.item_id
  group by p.id
)
select p.tenant_id, p.id as package_id, p.name, p.price_per_pax,
       a.cost as cost_per_pax,
       p.price_per_pax / s.tax_factor as net_price,
       a.cost / nullif(p.price_per_pax / s.tax_factor, 0) as food_cost,
       case when a.line_count = 0 or a.cost = 0 then 'No package recipe'
            when a.missing_price then 'No price'
            when a.cost / nullif(p.price_per_pax / s.tax_factor, 0) > s.target_cost_max then 'Above target cost'
            else 'OK' end as flag
from packages p
join agg a on a.package_id = p.id
join tenant_settings s on s.tenant_id = p.tenant_id;

-- ---------- Imports: resolve system items through aliases ----------
drop function if exists import_purchases(text,uuid,text,jsonb);
drop function if exists import_issues(text,uuid,uuid,jsonb,text,jsonb);
drop function if exists import_opening(text,uuid,date,jsonb);

-- p_rows: [{code,name,unit,price,date,qty,net,tax,total,po,grn,posted_by}]
create function import_purchases(p_file text, p_location uuid, p_mode text, p_rows jsonb)
returns jsonb language plpgsql security invoker as $$
declare t uuid := my_tenant(); b uuid; r jsonb; al item_aliases; og grn_lines; m stock_movements;
        ins int := 0; skp int := 0; rep int := 0; unm int := 0; q numeric; c numeric;
begin
  if t is null then raise exception 'no tenant'; end if;
  if p_mode not in ('skip','replace') then raise exception 'mode must be skip or replace'; end if;
  insert into import_batches (tenant_id, kind, file_name) values (t,'purchases',p_file) returning id into b;
  for r in select * from jsonb_array_elements(p_rows) loop
    select * into al from item_aliases where tenant_id = t and system_code = (r->>'code')::int;
    if not found then
      insert into unmapped_lines (tenant_id,kind,system_code,system_name,system_unit,params,row)
      values (t,'purchases',(r->>'code')::int,r->>'name',r->>'unit',jsonb_build_object('file',p_file,'location',p_location),r);
      unm := unm + 1; continue;
    end if;
    q := (r->>'qty')::numeric * al.factor;
    c := (r->>'price')::numeric / al.factor;
    select * into og from grn_lines where tenant_id = t and grn_no = (r->>'grn')::bigint and alias_id = al.id;
    if found then
      if p_mode = 'skip' then skp := skp + 1; continue; end if;
      for m in select * from stock_movements
               where tenant_id = t and alias_id = al.id and ref_no = 'GRN-'||(r->>'grn') and kind = 'receipt'
                 and not exists (select 1 from stock_movements x where x.reversal_of = stock_movements.id) loop
        insert into stock_movements (tenant_id,item_id,alias_id,location_id,movement_date,kind,qty,unit_cost,ref_no,note,batch_id,reversal_of)
        values (t,m.item_id,al.id,m.location_id,m.movement_date,'reversal',-m.qty,m.unit_cost,m.ref_no,'replaced by re-import',b,m.id);
      end loop;
      delete from grn_lines where id = og.id;
      rep := rep + 1;
    end if;
    insert into grn_lines (tenant_id,item_id,alias_id,grn_no,po_no,purchase_date,qty,unit_price,qty_ing,unit_cost_ing,
                           net_amount,tax,total,posted_by,location_id,batch_id)
    values (t,al.item_id,al.id,(r->>'grn')::bigint,nullif(r->>'po','')::bigint,(r->>'date')::date,(r->>'qty')::numeric,(r->>'price')::numeric,q,c,
            (r->>'net')::numeric,(r->>'tax')::numeric,(r->>'total')::numeric,r->>'posted_by',p_location,b);
    if p_location is not null then
      insert into stock_movements (tenant_id,item_id,alias_id,location_id,movement_date,kind,qty,unit_cost,ref_no,posted_by,batch_id)
      values (t,al.item_id,al.id,p_location,(r->>'date')::date,'receipt',q,c,'GRN-'||(r->>'grn'),r->>'posted_by',b);
    end if;
    ins := ins + 1;
  end loop;
  update import_batches set row_count = ins, skipped_count = skp, replaced_count = rep where id = b;
  return jsonb_build_object('batch', b, 'inserted', ins, 'skipped', skp, 'replaced', rep, 'unmapped', unm);
end $$;

-- p_rows: [{code,name,unit,price,date,qty,req,total,posted_by}]; p_source null = already handed over.
create function import_issues(p_file text, p_source uuid, p_default_dest uuid, p_map jsonb, p_mode text, p_rows jsonb)
returns jsonb language plpgsql security invoker as $$
declare t uuid := my_tenant(); b uuid; r jsonb; al item_aliases; dest uuid; ref text; tid uuid; oldt uuid;
        ins int := 0; skp int := 0; rep int := 0; unm int := 0; m stock_movements; q numeric; c numeric;
begin
  if t is null then raise exception 'no tenant'; end if;
  if p_mode not in ('skip','replace') then raise exception 'mode must be skip or replace'; end if;
  insert into import_batches (tenant_id, kind, file_name) values (t,'issues',p_file) returning id into b;
  for r in select * from jsonb_array_elements(p_rows) loop
    select * into al from item_aliases where tenant_id = t and system_code = (r->>'code')::int;
    if not found then
      insert into unmapped_lines (tenant_id,kind,system_code,system_name,system_unit,params,row)
      values (t,'issues',(r->>'code')::int,r->>'name',r->>'unit',
              jsonb_build_object('file',p_file,'source',p_source,'dest',p_default_dest,'map',p_map),r);
      unm := unm + 1; continue;
    end if;
    ref := 'REQ-'||(r->>'req');
    dest := coalesce(nullif(p_map->>(r->>'req'),'')::uuid, p_default_dest);
    if dest is null then raise exception 'no destination for requisition %', r->>'req'; end if;
    q := (r->>'qty')::numeric * al.factor;
    c := (r->>'price')::numeric / al.factor;
    select transfer_id into oldt from stock_movements
      where tenant_id = t and alias_id = al.id and ref_no = ref and kind = 'issue_in' and reversal_of is null
        and not exists (select 1 from stock_movements x where x.reversal_of = stock_movements.id)
      limit 1;
    if oldt is not null then
      if p_mode = 'skip' then skp := skp + 1; continue; end if;
      for m in select * from stock_movements
               where transfer_id = oldt and reversal_of is null
                 and not exists (select 1 from stock_movements x where x.reversal_of = stock_movements.id) loop
        insert into stock_movements (tenant_id,item_id,alias_id,location_id,movement_date,kind,qty,unit_cost,ref_no,transfer_id,note,batch_id,reversal_of)
        values (t,m.item_id,m.alias_id,m.location_id,m.movement_date,'reversal',-m.qty,m.unit_cost,m.ref_no,m.transfer_id,'replaced by re-import',b,m.id);
      end loop;
      rep := rep + 1;
    end if;
    tid := gen_random_uuid();
    if p_source is not null then
      insert into stock_movements (tenant_id,item_id,alias_id,location_id,movement_date,kind,qty,unit_cost,ref_no,transfer_id,posted_by,batch_id)
      values (t,al.item_id,al.id,p_source,(r->>'date')::date,'issue_out',-q,c,ref,tid,r->>'posted_by',b);
    end if;
    insert into stock_movements (tenant_id,item_id,alias_id,location_id,movement_date,kind,qty,unit_cost,ref_no,transfer_id,posted_by,batch_id)
    values (t,al.item_id,al.id,dest,(r->>'date')::date,'issue_in',q,c,ref,tid,r->>'posted_by',b);
    ins := ins + 1;
  end loop;
  update import_batches set row_count = ins, skipped_count = skp, replaced_count = rep where id = b;
  return jsonb_build_object('batch', b, 'inserted', ins, 'skipped', skp, 'replaced', rep, 'unmapped', unm);
end $$;

-- p_rows: [{code,name,unit,qty}] in system units, all into p_location as of p_date. Existing opening rows are skipped.
create function import_opening(p_file text, p_location uuid, p_date date, p_rows jsonb)
returns jsonb language plpgsql security invoker as $$
declare t uuid := my_tenant(); b uuid; r jsonb; al item_aliases; ins int := 0; skp int := 0; unm int := 0;
begin
  if t is null then raise exception 'no tenant'; end if;
  insert into import_batches (tenant_id, kind, file_name) values (t,'opening',p_file) returning id into b;
  for r in select * from jsonb_array_elements(p_rows) loop
    select * into al from item_aliases where tenant_id = t and system_code = (r->>'code')::int;
    if not found then
      insert into unmapped_lines (tenant_id,kind,system_code,system_name,system_unit,params,row)
      values (t,'opening',(r->>'code')::int,r->>'name',r->>'unit',jsonb_build_object('file',p_file,'location',p_location,'date',p_date),r);
      unm := unm + 1; continue;
    end if;
    if exists (select 1 from stock_movements where tenant_id = t and alias_id = al.id and location_id = p_location and kind = 'opening') then
      skp := skp + 1; continue;
    end if;
    insert into stock_movements (tenant_id,item_id,alias_id,location_id,movement_date,kind,qty,unit_cost,ref_no,batch_id)
    values (t,al.item_id,al.id,p_location,p_date,'opening',(r->>'qty')::numeric * al.factor,null,'OPENING',b);
    ins := ins + 1;
  end loop;
  update import_batches set row_count = ins, skipped_count = skp where id = b;
  return jsonb_build_object('batch', b, 'inserted', ins, 'skipped', skp, 'unmapped', unm);
end $$;

-- After a system item gets an alias, post the rows that were waiting for it.
create function process_unmapped(p_code int) returns int language plpgsql security invoker as $$
declare t uuid := my_tenant(); g record; n int := 0; rows jsonb;
begin
  if t is null then raise exception 'no tenant'; end if;
  if not exists (select 1 from item_aliases where tenant_id = t and system_code = p_code) then
    raise exception 'system item % has no alias yet', p_code; end if;
  for g in select kind, params, jsonb_agg(row order by created_at) as rows, array_agg(id) as ids
           from unmapped_lines where tenant_id = t and system_code = p_code group by kind, params loop
    if g.kind = 'purchases' then
      perform import_purchases(g.params->>'file', nullif(g.params->>'location','')::uuid, 'skip', g.rows);
    elsif g.kind = 'issues' then
      perform import_issues(g.params->>'file', nullif(g.params->>'source','')::uuid, nullif(g.params->>'dest','')::uuid,
                            coalesce(g.params->'map','{}'::jsonb), 'skip', g.rows);
    else
      perform import_opening(g.params->>'file', (g.params->>'location')::uuid, (g.params->>'date')::date, g.rows);
    end if;
    delete from unmapped_lines where id = any(g.ids);
    n := n + jsonb_array_length(g.rows);
  end loop;
  return n;
end $$;

-- ---------- Manual entries and reversal, now in ingredient units ----------
drop function if exists transfer_stock(uuid,uuid,uuid,date,numeric,text,text,text);
drop function if exists record_stock_out(uuid,uuid,date,numeric,text,text,text);

create function transfer_stock(p_item uuid, p_from uuid, p_to uuid, p_date date, p_qty numeric,
                               p_kind text, p_ref text, p_note text)
returns uuid language plpgsql security invoker as $$
declare t uuid := my_tenant(); tid uuid := gen_random_uuid(); cost numeric;
begin
  if t is null then raise exception 'no tenant'; end if;
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;
  if p_kind not in ('issue','transfer') then raise exception 'kind must be issue or transfer'; end if;
  if p_from = p_to then raise exception 'source and destination are the same'; end if;
  select unit_cost into cost from items where id = p_item and tenant_id = t;
  insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,transfer_id,note)
  values (t,p_item,p_from,p_date,p_kind||'_out',-p_qty,cost,p_ref,tid,p_note),
         (t,p_item,p_to,  p_date,p_kind||'_in', p_qty,cost,p_ref,tid,p_note);
  return tid;
end $$;

create function record_stock_out(p_item uuid, p_location uuid, p_date date, p_qty numeric,
                                 p_kind text, p_ref text, p_note text)
returns uuid language plpgsql security invoker as $$
declare t uuid := my_tenant(); mid uuid; cost numeric;
begin
  if t is null then raise exception 'no tenant'; end if;
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;
  if p_kind not in ('spoilage','staff_meal','complimentary','conference') then raise exception 'bad kind'; end if;
  select unit_cost into cost from items where id = p_item and tenant_id = t;
  insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,note)
  values (t,p_item,p_location,p_date,p_kind,-p_qty,cost,p_ref,p_note) returning id into mid;
  return mid;
end $$;

create or replace function reverse_batch(p_batch uuid) returns int language plpgsql security invoker as $$
declare t uuid := my_tenant(); b import_batches; m stock_movements; n int := 0; iid uuid;
begin
  select * into b from import_batches where id = p_batch and tenant_id = t;
  if not found then raise exception 'batch not found'; end if;
  if b.reversed_at is not null then raise exception 'batch already reversed'; end if;
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
  update import_batches set reversed_at = now() where id = p_batch;
  return n;
end $$;

-- ---------- RLS and audit for the new tables ----------
do $$
declare t text;
begin
  foreach t in array array['item_aliases','unmapped_lines','package_sales','tenant_settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I for all using (tenant_id in (select current_tenant_ids())) with check (tenant_id in (select current_tenant_ids()))', t);
  end loop;
  foreach t in array array['item_aliases','tenant_settings'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s for each row execute function audit_row()', t);
  end loop;
end $$;
-- audit_row() reads row ids from an "id" column; tenant_settings has none, so it logs a null row_id. Acceptable.

create or replace function bootstrap_tenant(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if exists (select 1 from tenant_members where user_id = auth.uid()) then
    raise exception 'already set up'; end if;
  insert into tenants (name) values (p_name) returning id into tid;
  insert into tenant_members (tenant_id, user_id, role) values (tid, auth.uid(), 'owner');
  insert into tenant_settings (tenant_id) values (tid);
  insert into locations (tenant_id, branch, name, kind) values
    (tid,'Cottages','Kitchen','kitchen'),
    (tid,'Cottages','Duma Bar','bar'),
    (tid,'Cottages','Dispense Bar','bar'),
    (tid,'Tuuti','Kitchen','kitchen'),
    (tid,'Tuuti','Duma Bar','bar');
  return tid;
end $$;

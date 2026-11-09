-- Qost phase 2: import batches, ledger in report units, import and transfer functions.
-- Run in the Supabase SQL Editor after 0001_core.sql. Safe to run on empty tables only.

-- ---------- Ledger: quantities in the item's report unit ----------
-- Pack sizes are often set after the first import, so the ledger stores the unit used in the
-- reports (CARTON, KGS, ...). Least-unit amounts are derived through items.base_per_purchase_unit.
drop view if exists stock_balances;
drop view if exists recipe_costs;

alter table stock_movements drop constraint stock_movements_kind_check;
alter table stock_movements add constraint stock_movements_kind_check check (kind in
  ('receipt','issue_out','issue_in','transfer_out','transfer_in',
   'spoilage','staff_meal','complimentary','conference','count_adjust','opening','reversal'));

alter table stock_movements drop column qty_base;
alter table stock_movements add column qty numeric not null;   -- signed, in the item's report unit
alter table stock_movements rename column unit_cost_base to unit_cost;  -- per report unit
alter table stock_movements add column reversal_of uuid references stock_movements(id);

-- ---------- Item cost: last unit price, cost per least unit derived ----------
alter table items drop column last_cost_per_base;
alter table items add column last_unit_price numeric;          -- VAT-inclusive, per report unit
alter table items add column last_cost_per_base numeric
  generated always as (last_unit_price / nullif(base_per_purchase_unit, 0)) stored;

create or replace function apply_grn_cost() returns trigger language plpgsql as $$
begin
  update items set last_unit_price = new.unit_price, last_cost_at = new.purchase_date
  where id = new.item_id and (last_cost_at is null or last_cost_at <= new.purchase_date);
  return new;
end $$;

-- ---------- Import batches ----------
create table import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('purchases','issues','opening')),
  file_name text,
  row_count int not null default 0,
  skipped_count int not null default 0,
  replaced_count int not null default 0,
  created_at timestamptz not null default now(),
  reversed_at timestamptz
);
alter table import_batches enable row level security;
create policy tenant_isolation on import_batches for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

alter table grn_lines add column batch_id uuid references import_batches(id);
alter table stock_movements add column batch_id uuid references import_batches(id);

-- ---------- Views ----------
create view stock_balances with (security_invoker = true) as
select m.tenant_id, m.item_id, m.location_id,
       sum(m.qty) as qty,
       i.base_per_purchase_unit,
       sum(m.qty) * i.base_per_purchase_unit as qty_base
from stock_movements m join items i on i.id = m.item_id
group by m.tenant_id, m.item_id, m.location_id, i.base_per_purchase_unit;

create view recipe_costs with (security_invoker = true) as
select r.tenant_id, r.id as recipe_id, r.name,
       sum(l.qty_base * i.last_cost_per_base) / nullif(r.yield_portions,0) as cost_per_portion,
       r.selling_price, r.target_cost_pct,
       round(100 * (sum(l.qty_base * i.last_cost_per_base) / nullif(r.yield_portions,0)) / nullif(r.selling_price,0), 1) as food_cost_pct,
       bool_or(i.last_cost_per_base is null) as missing_price,
       count(l.id) = 0 as missing_lines
from recipes r
left join recipe_lines l on l.recipe_id = r.id
left join items i on i.id = l.item_id
group by r.id;

-- ---------- Helpers ----------
create function my_tenant() returns uuid language sql stable security definer set search_path = public as $$
  select tenant_id from tenant_members where user_id = auth.uid() limit 1
$$;

-- Finds or creates an item and its group from report columns.
create function ensure_item(p_tenant uuid, p_code int, p_name text, p_group text, p_unit text)
returns uuid language plpgsql security invoker as $$
declare gid uuid; iid uuid;
begin
  select id into iid from items where tenant_id = p_tenant and code = p_code;
  if iid is not null then return iid; end if;
  if p_group is not null and p_group <> '' then
    select id into gid from item_groups where tenant_id = p_tenant and name = p_group;
    if gid is null then
      insert into item_groups (tenant_id, name, is_food)
      values (p_tenant, p_group, p_group !~* 'FUEL|ENERGY|STATION|BUSINESS|EXPENSE|PAPER|CLEANING|DETERGENT|REPAIR|MAINT')
      returning id into gid;
    end if;
  end if;
  insert into items (tenant_id, code, name, group_id, purchase_unit)
  values (p_tenant, p_code, p_name, gid, p_unit) returning id into iid;
  return iid;
end $$;

-- ---------- Purchases import ----------
-- p_rows: [{code,name,group,unit,price,date,qty,net,tax,total,po,grn,posted_by}]
-- p_mode: 'skip' leaves duplicates alone, 'replace' reverses the old receipt and re-enters it.
create function import_purchases(p_file text, p_location uuid, p_mode text, p_rows jsonb)
returns jsonb language plpgsql security invoker as $$
declare t uuid := my_tenant(); b uuid; r jsonb; iid uuid; og grn_lines; m stock_movements; ins int := 0; skp int := 0; rep int := 0;
begin
  if t is null then raise exception 'no tenant'; end if;
  if p_mode not in ('skip','replace') then raise exception 'mode must be skip or replace'; end if;
  insert into import_batches (tenant_id, kind, file_name) values (t,'purchases',p_file) returning id into b;
  for r in select * from jsonb_array_elements(p_rows) loop
    iid := ensure_item(t, (r->>'code')::int, r->>'name', r->>'group', r->>'unit');
    select * into og from grn_lines where tenant_id = t and grn_no = (r->>'grn')::bigint and item_id = iid;
    if found then
      if p_mode = 'skip' then skp := skp + 1; continue; end if;
      for m in select * from stock_movements
               where tenant_id = t and item_id = iid and ref_no = 'GRN-'||(r->>'grn') and kind = 'receipt'
                 and not exists (select 1 from stock_movements x where x.reversal_of = stock_movements.id) loop
        insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,note,batch_id,reversal_of)
        values (t,iid,m.location_id,m.movement_date,'reversal',-m.qty,m.unit_cost,m.ref_no,'replaced by re-import',b,m.id);
      end loop;
      delete from grn_lines where id = og.id;
      rep := rep + 1;
    end if;
    insert into grn_lines (tenant_id,item_id,grn_no,po_no,purchase_date,qty,unit_price,net_amount,tax,total,posted_by,location_id,batch_id)
    values (t,iid,(r->>'grn')::bigint,nullif(r->>'po','')::bigint,(r->>'date')::date,(r->>'qty')::numeric,
            (r->>'price')::numeric,(r->>'net')::numeric,(r->>'tax')::numeric,(r->>'total')::numeric,r->>'posted_by',p_location,b);
    insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,posted_by,batch_id)
    values (t,iid,p_location,(r->>'date')::date,'receipt',(r->>'qty')::numeric,(r->>'price')::numeric,'GRN-'||(r->>'grn'),r->>'posted_by',b);
    ins := ins + 1;
  end loop;
  update import_batches set row_count = ins, skipped_count = skp, replaced_count = rep where id = b;
  return jsonb_build_object('batch', b, 'inserted', ins, 'skipped', skp, 'replaced', rep);
end $$;

-- ---------- Issues import ----------
-- p_map: {"<ReqNo>": "<destination location uuid>"} overrides p_default_dest per requisition.
-- p_rows: [{code,name,group,unit,price,date,qty,req,total,posted_by}]
create function import_issues(p_file text, p_source uuid, p_default_dest uuid, p_map jsonb, p_mode text, p_rows jsonb)
returns jsonb language plpgsql security invoker as $$
declare t uuid := my_tenant(); b uuid; r jsonb; iid uuid; dest uuid; ref text; tid uuid;
        ins int := 0; skp int := 0; rep int := 0; oldt uuid; m stock_movements;
begin
  if t is null then raise exception 'no tenant'; end if;
  if p_mode not in ('skip','replace') then raise exception 'mode must be skip or replace'; end if;
  insert into import_batches (tenant_id, kind, file_name) values (t,'issues',p_file) returning id into b;
  for r in select * from jsonb_array_elements(p_rows) loop
    iid := ensure_item(t, (r->>'code')::int, r->>'name', r->>'group', r->>'unit');
    ref := 'REQ-'||(r->>'req');
    dest := coalesce(nullif(p_map->>(r->>'req'),'')::uuid, p_default_dest);
    if dest is null then raise exception 'no destination for requisition %', r->>'req'; end if;
    select transfer_id into oldt from stock_movements
      where tenant_id = t and item_id = iid and ref_no = ref and kind = 'issue_out' and reversal_of is null
        and not exists (select 1 from stock_movements x where x.reversal_of = stock_movements.id)
      limit 1;
    if oldt is not null then
      if p_mode = 'skip' then skp := skp + 1; continue; end if;
      for m in select * from stock_movements where transfer_id = oldt and reversal_of is null loop
        insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,transfer_id,note,batch_id,reversal_of)
        values (t,m.item_id,m.location_id,m.movement_date,'reversal',-m.qty,m.unit_cost,m.ref_no,m.transfer_id,'replaced by re-import',b,m.id);
      end loop;
      rep := rep + 1;
    end if;
    tid := gen_random_uuid();
    insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,transfer_id,posted_by,batch_id)
    values (t,iid,p_source,(r->>'date')::date,'issue_out',-(r->>'qty')::numeric,(r->>'price')::numeric,ref,tid,r->>'posted_by',b),
           (t,iid,dest,    (r->>'date')::date,'issue_in',  (r->>'qty')::numeric,(r->>'price')::numeric,ref,tid,r->>'posted_by',b);
    ins := ins + 1;
  end loop;
  update import_batches set row_count = ins, skipped_count = skp, replaced_count = rep where id = b;
  return jsonb_build_object('batch', b, 'inserted', ins, 'skipped', skp, 'replaced', rep);
end $$;

-- ---------- Opening stock import ----------
-- p_rows: [{code,name,group,unit,qty}], all into p_location as of p_date. Existing opening rows are skipped.
create function import_opening(p_file text, p_location uuid, p_date date, p_rows jsonb)
returns jsonb language plpgsql security invoker as $$
declare t uuid := my_tenant(); b uuid; r jsonb; iid uuid; ins int := 0; skp int := 0;
begin
  if t is null then raise exception 'no tenant'; end if;
  insert into import_batches (tenant_id, kind, file_name) values (t,'opening',p_file) returning id into b;
  for r in select * from jsonb_array_elements(p_rows) loop
    iid := ensure_item(t, (r->>'code')::int, r->>'name', r->>'group', r->>'unit');
    if exists (select 1 from stock_movements where tenant_id = t and item_id = iid and location_id = p_location and kind = 'opening') then
      skp := skp + 1; continue;
    end if;
    insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,batch_id)
    values (t,iid,p_location,p_date,'opening',(r->>'qty')::numeric,null,'OPENING',b);
    ins := ins + 1;
  end loop;
  update import_batches set row_count = ins, skipped_count = skp where id = b;
  return jsonb_build_object('batch', b, 'inserted', ins, 'skipped', skp);
end $$;

-- ---------- Manual transfer / issue (both legs, atomic) ----------
drop function transfer_stock(uuid,uuid,uuid,uuid,date,numeric,text,text,text,text);
create function transfer_stock(p_item uuid, p_from uuid, p_to uuid, p_date date, p_qty numeric,
                               p_kind text, p_ref text, p_note text)
returns uuid language plpgsql security invoker as $$
declare t uuid := my_tenant(); tid uuid := gen_random_uuid(); cost numeric;
begin
  if t is null then raise exception 'no tenant'; end if;
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;
  if p_kind not in ('issue','transfer') then raise exception 'kind must be issue or transfer'; end if;
  if p_from = p_to then raise exception 'source and destination are the same'; end if;
  select last_unit_price into cost from items where id = p_item and tenant_id = t;
  insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,transfer_id,note)
  values (t,p_item,p_from,p_date,p_kind||'_out',-p_qty,cost,p_ref,tid,p_note),
         (t,p_item,p_to,  p_date,p_kind||'_in', p_qty,cost,p_ref,tid,p_note);
  return tid;
end $$;

-- Single-leg stock out: spoilage, staff meals, complimentaries, conference issues.
create function record_stock_out(p_item uuid, p_location uuid, p_date date, p_qty numeric,
                                 p_kind text, p_ref text, p_note text)
returns uuid language plpgsql security invoker as $$
declare t uuid := my_tenant(); mid uuid; cost numeric;
begin
  if t is null then raise exception 'no tenant'; end if;
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;
  if p_kind not in ('spoilage','staff_meal','complimentary','conference') then raise exception 'bad kind'; end if;
  select last_unit_price into cost from items where id = p_item and tenant_id = t;
  insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,note)
  values (t,p_item,p_location,p_date,p_kind,-p_qty,cost,p_ref,p_note) returning id into mid;
  return mid;
end $$;

-- ---------- Reverse a whole import batch ----------
create function reverse_batch(p_batch uuid) returns int language plpgsql security invoker as $$
declare t uuid := my_tenant(); b import_batches; m stock_movements; n int := 0; iid uuid;
begin
  select * into b from import_batches where id = p_batch and tenant_id = t;
  if not found then raise exception 'batch not found'; end if;
  if b.reversed_at is not null then raise exception 'batch already reversed'; end if;
  for m in select * from stock_movements
           where batch_id = p_batch and reversal_of is null and kind <> 'reversal'
             and not exists (select 1 from stock_movements x where x.reversal_of = stock_movements.id) loop
    insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,transfer_id,note,reversal_of)
    values (t,m.item_id,m.location_id,m.movement_date,'reversal',-m.qty,m.unit_cost,m.ref_no,m.transfer_id,'batch reversed',m.id);
    n := n + 1;
  end loop;
  if b.kind = 'purchases' then
    delete from grn_lines where batch_id = p_batch;
    -- recompute last price for items touched by the batch
    for iid in select distinct item_id from stock_movements where batch_id = p_batch loop
      update items i set
        last_unit_price = (select g.unit_price from grn_lines g where g.item_id = iid order by g.purchase_date desc, g.created_at desc limit 1),
        last_cost_at    = (select g.purchase_date from grn_lines g where g.item_id = iid order by g.purchase_date desc, g.created_at desc limit 1)
      where i.id = iid;
    end loop;
  end if;
  update import_batches set reversed_at = now() where id = p_batch;
  return n;
end $$;

-- Issues that are still in force (not reversed), used for duplicate detection in the import preview.
create view active_issues with (security_invoker = true) as
select m.tenant_id, m.item_id, m.ref_no, m.movement_date, -m.qty as qty
from stock_movements m
where m.kind = 'issue_out' and m.reversal_of is null
  and not exists (select 1 from stock_movements x where x.reversal_of = m.id);

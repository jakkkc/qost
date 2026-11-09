-- Qost 0003: real locations, no central store, optional source on issues.
-- Run after 0002_phase2.sql.
--   Cottages: Kitchen, Duma Bar, Dispense Bar
--   Tuuti:    Kitchen, Duma Bar

-- ---------- Locations ----------
alter table locations drop constraint locations_kind_check;
alter table locations add constraint locations_kind_check check (kind in ('store','kitchen','bar','outlet','other'));

-- Rename what the first bootstrap created, add what is missing.
update locations set name = 'Kitchen' where name in ('Main Kitchen','Tuuti Kitchen');

insert into locations (tenant_id, branch, name, kind)
select t.id, v.branch, v.name, v.kind
from tenants t
cross join (values ('Cottages','Kitchen','kitchen'),('Cottages','Duma Bar','bar'),('Cottages','Dispense Bar','bar'),
                   ('Tuuti','Kitchen','kitchen'),('Tuuti','Duma Bar','bar')) as v(branch,name,kind)
on conflict (tenant_id, branch, name) do update set kind = excluded.kind;

-- Central stores are gone. Remove them if nothing refers to them; otherwise keep and let the user decide.
delete from locations l
where l.name = 'Central Store'
  and not exists (select 1 from stock_movements m where m.location_id = l.id)
  and not exists (select 1 from grn_lines g where g.location_id = l.id)
  and not exists (select 1 from stock_counts c where c.location_id = l.id)
  and not exists (select 1 from par_levels p where p.location_id = l.id);

create or replace function bootstrap_tenant(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if exists (select 1 from tenant_members where user_id = auth.uid()) then
    raise exception 'already set up'; end if;
  insert into tenants (name) values (p_name) returning id into tid;
  insert into tenant_members (tenant_id, user_id, role) values (tid, auth.uid(), 'owner');
  insert into locations (tenant_id, branch, name, kind) values
    (tid,'Cottages','Kitchen','kitchen'),
    (tid,'Cottages','Duma Bar','bar'),
    (tid,'Cottages','Dispense Bar','bar'),
    (tid,'Tuuti','Kitchen','kitchen'),
    (tid,'Tuuti','Duma Bar','bar');
  return tid;
end $$;

-- ---------- Duplicate detection for issues now keys on the receiving leg ----------
create or replace view active_issues with (security_invoker = true) as
select m.tenant_id, m.item_id, m.ref_no, m.movement_date, m.qty
from stock_movements m
where m.kind = 'issue_in' and m.reversal_of is null
  and not exists (select 1 from stock_movements x where x.reversal_of = m.id);

-- ---------- Purchases: location optional (null = price history only, no stock) ----------
create or replace function import_purchases(p_file text, p_location uuid, p_mode text, p_rows jsonb)
returns jsonb language plpgsql security invoker as $$
declare t uuid := my_tenant(); b uuid; r jsonb; iid uuid; og grn_lines; m stock_movements;
        ins int := 0; skp int := 0; rep int := 0;
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
    if p_location is not null then
      insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,posted_by,batch_id)
      values (t,iid,p_location,(r->>'date')::date,'receipt',(r->>'qty')::numeric,(r->>'price')::numeric,'GRN-'||(r->>'grn'),r->>'posted_by',b);
    end if;
    ins := ins + 1;
  end loop;
  update import_batches set row_count = ins, skipped_count = skp, replaced_count = rep where id = b;
  return jsonb_build_object('batch', b, 'inserted', ins, 'skipped', skp, 'replaced', rep);
end $$;

-- ---------- Issues: p_source optional (null = already handed over, only the receiving side is recorded) ----------
create or replace function import_issues(p_file text, p_source uuid, p_default_dest uuid, p_map jsonb, p_mode text, p_rows jsonb)
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
      where tenant_id = t and item_id = iid and ref_no = ref and kind = 'issue_in' and reversal_of is null
        and not exists (select 1 from stock_movements x where x.reversal_of = stock_movements.id)
      limit 1;
    if oldt is not null then
      if p_mode = 'skip' then skp := skp + 1; continue; end if;
      for m in select * from stock_movements
               where transfer_id = oldt and reversal_of is null
                 and not exists (select 1 from stock_movements x where x.reversal_of = stock_movements.id) loop
        insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,transfer_id,note,batch_id,reversal_of)
        values (t,m.item_id,m.location_id,m.movement_date,'reversal',-m.qty,m.unit_cost,m.ref_no,m.transfer_id,'replaced by re-import',b,m.id);
      end loop;
      rep := rep + 1;
    end if;
    tid := gen_random_uuid();
    if p_source is not null then
      insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,transfer_id,posted_by,batch_id)
      values (t,iid,p_source,(r->>'date')::date,'issue_out',-(r->>'qty')::numeric,(r->>'price')::numeric,ref,tid,r->>'posted_by',b);
    end if;
    insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty,unit_cost,ref_no,transfer_id,posted_by,batch_id)
    values (t,iid,dest,(r->>'date')::date,'issue_in',(r->>'qty')::numeric,(r->>'price')::numeric,ref,tid,r->>'posted_by',b);
    ins := ins + 1;
  end loop;
  update import_batches set row_count = ins, skipped_count = skp, replaced_count = rep where id = b;
  return jsonb_build_object('batch', b, 'inserted', ins, 'skipped', skp, 'replaced', rep);
end $$;

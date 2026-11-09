-- Qost core schema. Run once in the Supabase SQL Editor (Project > SQL Editor).
-- Multi-tenant from day one: every table has tenant_id and an RLS policy.

create extension if not exists pgcrypto;

-- ---------- Tenancy ----------
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table tenant_members (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','cost_controller','chef','stores','finance')),
  primary key (tenant_id, user_id)
);

create function current_tenant_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from tenant_members where user_id = auth.uid()
$$;

-- ---------- Master data ----------
create table locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  branch text not null,                       -- e.g. 'Cottages', 'Tuuti'
  name text not null,                         -- e.g. 'Central Store', 'Main Kitchen'
  kind text not null check (kind in ('store','kitchen','outlet','other')),
  unique (tenant_id, branch, name)
);

create table item_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  is_food boolean not null default true,      -- false: fuel, stationery, etc.
  unique (tenant_id, name)
);

create table items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code integer not null,                      -- 'Item Code' in the internal system
  name text not null,
  group_id uuid references item_groups(id),
  purchase_unit text,                         -- as reported: CARTON, PKTS, KGS...
  base_unit text check (base_unit in ('g','ml','each')),  -- least unit
  base_per_purchase_unit numeric,             -- e.g. 1 CARTON = 12000 ml; null until set
  last_cost_per_base numeric,                 -- last purchase price, VAT-inclusive, per least unit
  last_cost_at date,
  unique (tenant_id, code)
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  unique (tenant_id, name)
);

-- ---------- Purchases ----------
create table grn_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_id uuid not null references items(id),
  supplier_id uuid references suppliers(id),
  grn_no bigint not null,
  po_no bigint,
  purchase_date date not null,
  qty numeric not null,                       -- in purchase units
  unit_price numeric not null,                -- VAT-inclusive, per purchase unit
  net_amount numeric,
  tax numeric,
  total numeric,
  posted_by text,
  location_id uuid references locations(id),  -- receiving store
  created_at timestamptz not null default now(),
  unique (tenant_id, grn_no, item_id)
);

-- Price history is derived from grn_lines. Flag increases in a view:
create view price_history as
select g.tenant_id, g.item_id, g.purchase_date, g.unit_price,
       lag(g.unit_price) over w as previous_price,
       case when lag(g.unit_price) over w is not null and g.unit_price > lag(g.unit_price) over w
            then round((g.unit_price / lag(g.unit_price) over w - 1) * 100, 1) end as increase_pct
from grn_lines g
window w as (partition by g.tenant_id, g.item_id order by g.purchase_date, g.created_at);

-- ---------- Stock ledger (append-only) ----------
create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_id uuid not null references items(id),
  location_id uuid not null references locations(id),
  movement_date date not null,
  kind text not null check (kind in
    ('receipt','issue_out','issue_in','transfer_out','transfer_in',
     'spoilage','staff_meal','complimentary','conference','count_adjust')),
  qty_base numeric not null,                  -- signed, in least units (+ in, - out)
  unit_cost_base numeric,                     -- cost at the time
  ref_no text,                                -- GRN no / ReqNo / transfer ref
  transfer_id uuid,                           -- pairs the out and in legs
  note text,
  posted_by text,
  created_at timestamptz not null default now()
);
create index on stock_movements (tenant_id, item_id, location_id);
create index on stock_movements (tenant_id, movement_date);

-- Prevent edits: the ledger is append-only. Corrections are new movements.
create function block_ledger_changes() returns trigger language plpgsql as $$
begin raise exception 'stock_movements is append-only'; end $$;
create trigger stock_movements_no_update before update or delete on stock_movements
  for each row execute function block_ledger_changes();

create view stock_balances as
select tenant_id, item_id, location_id, sum(qty_base) as qty_base
from stock_movements group by tenant_id, item_id, location_id;

-- Updating the last purchase cost per least unit when a GRN line arrives.
create function apply_grn_cost() returns trigger language plpgsql as $$
declare f numeric;
begin
  select base_per_purchase_unit into f from items where id = new.item_id;
  if f is not null and f > 0 then
    update items set last_cost_per_base = new.unit_price / f, last_cost_at = new.purchase_date
    where id = new.item_id and (last_cost_at is null or last_cost_at <= new.purchase_date);
  end if;
  return new;
end $$;
create trigger grn_updates_cost after insert on grn_lines
  for each row execute function apply_grn_cost();

-- Atomic transfer / issue: writes both legs in one transaction.
create function transfer_stock(
  p_tenant uuid, p_item uuid, p_from uuid, p_to uuid, p_date date,
  p_qty_base numeric, p_kind text, p_ref text, p_note text, p_by text
) returns uuid language plpgsql security invoker as $$
declare tid uuid := gen_random_uuid(); cost numeric;
begin
  if p_qty_base <= 0 then raise exception 'qty must be positive'; end if;
  if p_kind not in ('issue','transfer') then raise exception 'kind must be issue or transfer'; end if;
  select last_cost_per_base into cost from items where id = p_item and tenant_id = p_tenant;
  insert into stock_movements (tenant_id,item_id,location_id,movement_date,kind,qty_base,unit_cost_base,ref_no,transfer_id,note,posted_by)
  values (p_tenant,p_item,p_from,p_date,p_kind||'_out',-p_qty_base,cost,p_ref,tid,p_note,p_by),
         (p_tenant,p_item,p_to,  p_date,p_kind||'_in', p_qty_base,cost,p_ref,tid,p_note,p_by);
  return tid;
end $$;

-- ---------- Recipes and packages ----------
create table recipes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  category text,
  yield_portions numeric not null default 1,   -- portions the recipe produces
  portion_size text,
  selling_price numeric,                       -- per portion, VAT-inclusive
  target_cost_pct numeric,                     -- per recipe; falls back to category/global later
  unique (tenant_id, name)
);

create table recipe_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  recipe_id uuid not null references recipes(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_base numeric not null                    -- for the whole recipe, in least units
);

create view recipe_costs as
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

create table packages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('bundle','per_head')),
  selling_price numeric,                       -- per bundle or per head
  unique (tenant_id, name)
);

create table package_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  package_id uuid not null references packages(id) on delete cascade,
  recipe_id uuid not null references recipes(id),
  portions numeric not null default 1          -- portions of that recipe per bundle / per head
);

-- ---------- POS sales (Nomad) ----------
create table pos_item_map (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  pos_code integer not null,
  pos_name text,
  recipe_id uuid references recipes(id),
  package_id uuid references packages(id),
  check (not (recipe_id is not null and package_id is not null)),
  unique (tenant_id, pos_code)
);

create table sales_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  branch text not null,
  date_from date not null,
  date_to date not null,
  file_name text,
  created_at timestamptz not null default now()
);

create table sales_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  import_id uuid not null references sales_imports(id) on delete cascade,
  pos_code integer not null,
  pos_name text,
  item_source text,
  group_name text,
  unit_price numeric,
  sold_qty numeric not null,
  gross_total numeric,
  income_account text,
  tax_total numeric,
  net_sales numeric
);

-- ---------- Counts, par levels, audit ----------
create table stock_counts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid not null references locations(id),
  item_id uuid not null references items(id),
  count_date date not null,
  counted_qty_base numeric not null,
  expected_qty_base numeric,                   -- snapshot of the system balance
  counted_by text,
  unique (tenant_id, location_id, item_id, count_date)
);

create table par_levels (
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  par_qty_base numeric not null,
  reorder_qty_base numeric,
  primary key (tenant_id, item_id, location_id)
);

create table audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid,
  table_name text not null,
  row_id text,
  action text not null,
  old_row jsonb,
  new_row jsonb,
  changed_by uuid default auth.uid(),
  changed_at timestamptz not null default now()
);

create function audit_row() returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  insert into audit_log (tenant_id, table_name, row_id, action, old_row, new_row)
  values ((r->>'tenant_id')::uuid, tg_table_name, r->>'id', tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['items','grn_lines','recipes','recipe_lines','packages','package_lines','pos_item_map','par_levels','stock_counts','locations'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s for each row execute function audit_row()', t);
  end loop;
end $$;

-- ---------- Row Level Security ----------
do $$
declare t text;
begin
  foreach t in array array['locations','item_groups','items','suppliers','grn_lines','stock_movements',
    'recipes','recipe_lines','packages','package_lines','pos_item_map','sales_imports','sales_lines',
    'stock_counts','par_levels','audit_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I for all using (tenant_id in (select current_tenant_ids())) with check (tenant_id in (select current_tenant_ids()))', t);
  end loop;
end $$;

alter table tenants enable row level security;
create policy members_see_tenant on tenants for select using (id in (select current_tenant_ids()));
alter table tenant_members enable row level security;
create policy own_membership on tenant_members for select using (user_id = auth.uid());

-- Views run with the caller's rights so RLS applies.
alter view stock_balances set (security_invoker = true);
alter view price_history set (security_invoker = true);
alter view recipe_costs set (security_invoker = true);

-- ---------- First-run bootstrap ----------
-- Call once after signing up: select bootstrap_tenant('Hunters Paradise');
create function bootstrap_tenant(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if exists (select 1 from tenant_members where user_id = auth.uid()) then
    raise exception 'already set up'; end if;
  insert into tenants (name) values (p_name) returning id into tid;
  insert into tenant_members (tenant_id, user_id, role) values (tid, auth.uid(), 'owner');
  insert into locations (tenant_id, branch, name, kind) values
    (tid,'Cottages','Central Store','store'),
    (tid,'Cottages','Main Kitchen','kitchen'),
    (tid,'Tuuti','Central Store','store'),
    (tid,'Tuuti','Tuuti Kitchen','kitchen');
  return tid;
end $$;

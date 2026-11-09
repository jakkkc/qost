-- Qost 0005: one-off / repeatable import of the Recipe Cost Control Workbook. Run after 0004.

-- One POS item can stand for several dishes (e.g. POS 190 "Breakfast cereals" = Cornflakes, Branflakes, Weetabix)
-- or for a package, so links live in their own table.
alter table pos_items drop column recipe_id;
alter table pos_items drop column package_id;

create table pos_item_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  pos_item_id uuid not null references pos_items(id) on delete cascade,
  recipe_id uuid references recipes(id) on delete cascade,
  package_id uuid references packages(id) on delete cascade,
  check ((recipe_id is not null) <> (package_id is not null)),
  unique nulls not distinct (pos_item_id, recipe_id, package_id)
);
alter table pos_item_links enable row level security;
create policy tenant_isolation on pos_item_links for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- p: {items:[{name,unit,cost}], recipes:[{name,category,menu_price,on_menu,key_item}],
--     lines:[{dish,item,qty}], packages:[{name,price}], package_lines:[{package,name,qty}],
--     pos:[{code,name,group,price}], links:[{code,name}]}
-- Names are matched case-insensitively. Safe to run again: existing rows are updated, and the lines of
-- every dish / package in the payload are replaced by the payload's lines.
create function import_workbook(p jsonb) returns jsonb
language plpgsql security invoker as $$
declare t uuid := my_tenant(); x jsonb; rid uuid; iid uuid; pid uuid; posid uuid;
        n_items int := 0; n_recipes int := 0; n_lines int := 0; n_pkgs int := 0; n_pkg_lines int := 0; n_pos int := 0; n_links int := 0;
        dishes text[];
begin
  if t is null then raise exception 'no tenant'; end if;

  for x in select * from jsonb_array_elements(coalesce(p->'items','[]')) loop
    insert into items (tenant_id, name, unit, unit_cost, unit_cost_at)
    values (t, x->>'name', x->>'unit', nullif(x->>'cost','')::numeric, case when nullif(x->>'cost','') is not null then current_date end)
    on conflict (tenant_id, name) do update set unit = excluded.unit,
      unit_cost = coalesce(excluded.unit_cost, items.unit_cost);
    n_items := n_items + 1;
  end loop;

  for x in select * from jsonb_array_elements(coalesce(p->'recipes','[]')) loop
    select id into iid from items where tenant_id = t and lower(name) = lower(x->>'key_item');
    insert into recipes (tenant_id, name, category, menu_price, on_menu, key_item_id)
    values (t, x->>'name', nullif(x->>'category',''), nullif(x->>'menu_price','')::numeric, coalesce((x->>'on_menu')::boolean, false), iid)
    on conflict (tenant_id, name) do update set
      category = coalesce(excluded.category, recipes.category),
      menu_price = coalesce(excluded.menu_price, recipes.menu_price),
      on_menu = recipes.on_menu or excluded.on_menu,
      key_item_id = coalesce(excluded.key_item_id, recipes.key_item_id);
    n_recipes := n_recipes + 1;
  end loop;

  -- replace the lines of every dish that appears in the payload
  select array_agg(distinct lower(d)) into dishes from jsonb_array_elements_text(
    coalesce((select jsonb_agg(l->>'dish') from jsonb_array_elements(coalesce(p->'lines','[]')) l), '[]')) d;
  if dishes is not null then
    delete from recipe_lines where tenant_id = t
      and recipe_id in (select id from recipes where tenant_id = t and lower(name) = any(dishes));
  end if;
  for x in select * from jsonb_array_elements(coalesce(p->'lines','[]')) loop
    select id into rid from recipes where tenant_id = t and lower(name) = lower(x->>'dish');
    select id into iid from items   where tenant_id = t and lower(name) = lower(x->>'item');
    if rid is null then raise exception 'recipe line: dish "%" not found', x->>'dish'; end if;
    if iid is null then raise exception 'recipe line: ingredient "%" (dish "%") not found', x->>'item', x->>'dish'; end if;
    insert into recipe_lines (tenant_id, recipe_id, item_id, qty) values (t, rid, iid, (x->>'qty')::numeric);
    n_lines := n_lines + 1;
  end loop;

  for x in select * from jsonb_array_elements(coalesce(p->'packages','[]')) loop
    insert into packages (tenant_id, name, price_per_pax)
    values (t, x->>'name', nullif(x->>'price','')::numeric)
    on conflict (tenant_id, name) do update set price_per_pax = coalesce(excluded.price_per_pax, packages.price_per_pax);
    n_pkgs := n_pkgs + 1;
  end loop;
  delete from package_lines where tenant_id = t and package_id in (
    select id from packages where tenant_id = t and lower(name) in (
      select lower(l->>'package') from jsonb_array_elements(coalesce(p->'package_lines','[]')) l));
  for x in select * from jsonb_array_elements(coalesce(p->'package_lines','[]')) loop
    select id into pid from packages where tenant_id = t and lower(name) = lower(x->>'package');
    if pid is null then raise exception 'package line: package "%" not found', x->>'package'; end if;
    select id into rid from recipes where tenant_id = t and lower(name) = lower(x->>'name');
    if rid is not null then
      insert into package_lines (tenant_id, package_id, recipe_id, qty_per_pax) values (t, pid, rid, (x->>'qty')::numeric);
    else
      select id into iid from items where tenant_id = t and lower(name) = lower(x->>'name');
      if iid is null then raise exception 'package line: "%" (package "%") is neither a dish nor an ingredient', x->>'name', x->>'package'; end if;
      insert into package_lines (tenant_id, package_id, item_id, qty_per_pax) values (t, pid, iid, (x->>'qty')::numeric);
    end if;
    n_pkg_lines := n_pkg_lines + 1;
  end loop;

  for x in select * from jsonb_array_elements(coalesce(p->'pos','[]')) loop
    insert into pos_items (tenant_id, pos_code, pos_name, pos_group, pos_price)
    values (t, (x->>'code')::int, x->>'name', nullif(x->>'group',''), nullif(x->>'price','')::numeric)
    on conflict (tenant_id, pos_code) do update set pos_name = excluded.pos_name,
      pos_group = coalesce(excluded.pos_group, pos_items.pos_group), pos_price = coalesce(excluded.pos_price, pos_items.pos_price);
    n_pos := n_pos + 1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p->'links','[]')) loop
    select id into posid from pos_items where tenant_id = t and pos_code = (x->>'code')::int;
    if posid is null then raise exception 'link: POS item % not found', x->>'code'; end if;
    select id into rid from recipes  where tenant_id = t and lower(name) = lower(x->>'name');
    select id into pid from packages where tenant_id = t and lower(name) = lower(x->>'name');
    if rid is null and pid is null then raise exception 'link: "%" (POS %) is neither a dish nor a package', x->>'name', x->>'code'; end if;
    insert into pos_item_links (tenant_id, pos_item_id, recipe_id, package_id)
    values (t, posid, case when rid is not null then rid end, case when rid is null then pid end)
    on conflict do nothing;
    n_links := n_links + 1;
  end loop;

  return jsonb_build_object('items', n_items, 'recipes', n_recipes, 'lines', n_lines, 'packages', n_pkgs,
                            'package_lines', n_pkg_lines, 'pos_items', n_pos, 'links', n_links);
end $$;

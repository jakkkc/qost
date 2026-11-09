-- Qost 0006: atomic recipe save and the POS price check. Run after 0005.

-- p_recipe: {name, category, menu_price, on_menu, target_override (fraction, e.g. 0.35), key_item_id}
-- p_lines:  [{item_id, qty}]  (quantity per ONE portion, in the ingredient's unit)
create function save_recipe(p_id uuid, p_recipe jsonb, p_lines jsonb) returns uuid
language plpgsql security invoker as $$
declare t uuid := my_tenant(); rid uuid; l jsonb;
begin
  if t is null then raise exception 'no tenant'; end if;
  if coalesce(trim(p_recipe->>'name'), '') = '' then raise exception 'recipe needs a name'; end if;
  if p_id is null then
    insert into recipes (tenant_id, name, category, menu_price, on_menu, target_override, key_item_id)
    values (t, trim(p_recipe->>'name'), nullif(p_recipe->>'category',''), nullif(p_recipe->>'menu_price','')::numeric,
            coalesce((p_recipe->>'on_menu')::boolean, false), nullif(p_recipe->>'target_override','')::numeric,
            nullif(p_recipe->>'key_item_id','')::uuid)
    returning id into rid;
  else
    update recipes set name = trim(p_recipe->>'name'), category = nullif(p_recipe->>'category',''),
           menu_price = nullif(p_recipe->>'menu_price','')::numeric,
           on_menu = coalesce((p_recipe->>'on_menu')::boolean, false),
           target_override = nullif(p_recipe->>'target_override','')::numeric,
           key_item_id = nullif(p_recipe->>'key_item_id','')::uuid
    where id = p_id and tenant_id = t returning id into rid;
    if rid is null then raise exception 'recipe not found'; end if;
    delete from recipe_lines where recipe_id = rid;
  end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    insert into recipe_lines (tenant_id, recipe_id, item_id, qty)
    values (t, rid, (l->>'item_id')::uuid, (l->>'qty')::numeric);
  end loop;
  return rid;
end $$;

-- Same for packages. p_package: {name, price_per_pax}; p_lines: [{recipe_id|item_id, qty_per_pax}]
create function save_package(p_id uuid, p_package jsonb, p_lines jsonb) returns uuid
language plpgsql security invoker as $$
declare t uuid := my_tenant(); pid uuid; l jsonb;
begin
  if t is null then raise exception 'no tenant'; end if;
  if coalesce(trim(p_package->>'name'), '') = '' then raise exception 'package needs a name'; end if;
  if p_id is null then
    insert into packages (tenant_id, name, price_per_pax)
    values (t, trim(p_package->>'name'), nullif(p_package->>'price_per_pax','')::numeric) returning id into pid;
  else
    update packages set name = trim(p_package->>'name'), price_per_pax = nullif(p_package->>'price_per_pax','')::numeric
    where id = p_id and tenant_id = t returning id into pid;
    if pid is null then raise exception 'package not found'; end if;
    delete from package_lines where package_id = pid;
  end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    insert into package_lines (tenant_id, package_id, recipe_id, item_id, qty_per_pax)
    values (t, pid, nullif(l->>'recipe_id','')::uuid, nullif(l->>'item_id','')::uuid, (l->>'qty_per_pax')::numeric);
  end loop;
  return pid;
end $$;

-- POS item vs the workbook: linked dishes/packages, menu price, and the red flags of the POS Prices sheet.
create view pos_item_status with (security_invoker = true) as
select p.tenant_id, p.id as pos_item_id, p.pos_code, p.pos_name, p.pos_group, p.pos_price,
       coalesce(string_agg(distinct coalesce(r.name, pk.name), ', '), '') as linked,
       count(k.id) as link_count,
       min(coalesce(r.menu_price, pk.price_per_pax)) as menu_price,
       count(k.id) filter (where (r.id is not null and rc.flag <> 'No recipe')
                              or (pk.id is not null and pc.flag <> 'No package recipe')) > 0 as has_recipe,
       case when count(k.id) = 0 then 'Not in workbook'
            when count(k.id) filter (where coalesce(r.menu_price, pk.price_per_pax) is not null) = 0 then 'No menu price'
            when p.pos_price is not null
                 and bool_and(coalesce(r.menu_price, pk.price_per_pax) is null or p.pos_price <> coalesce(r.menu_price, pk.price_per_pax))
                 then 'Price differs'
            else 'OK' end as flag
from pos_items p
left join pos_item_links k on k.pos_item_id = p.id
left join recipes r on r.id = k.recipe_id
left join recipe_costs rc on rc.recipe_id = r.id
left join packages pk on pk.id = k.package_id
left join package_costs pc on pc.package_id = pk.id
group by p.id;

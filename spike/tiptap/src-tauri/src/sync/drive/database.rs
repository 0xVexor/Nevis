//! Cross-file database invariants at the Drive boundary. Canonical files remain the authority.
use super::super::snapshot::{self, Files};
use crate::vault::{err, now_ms, write_atomic, Res, Vault};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};
fn reference(records: &BTreeMap<String, BTreeMap<String, Value>>, kind: &str, id: &str) -> bool {
    records.get(kind).is_some_and(|r| r.contains_key(id))
}
fn reject_cycles(records: &BTreeMap<String, Value>, pointer: &str) -> Res<()> {
    let mut colors: BTreeMap<String, u8> = BTreeMap::new();
    for start in records.keys() {
        if colors.get(start) == Some(&2) {
            continue;
        }
        let mut path = vec![];
        let mut cursor = Some(start.clone());
        while let Some(id) = cursor {
            if colors.get(&id) == Some(&2) {
                break;
            }
            if colors.get(&id) == Some(&1) {
                return Err("DRIVE:db_parent_cycle".into());
            }
            let Some(record) = records.get(&id) else {
                break;
            };
            if !record["deletedAt"].is_null() {
                break;
            }
            colors.insert(id.clone(), 1);
            path.push(id);
            cursor = record
                .pointer(pointer)
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        for id in path {
            colors.insert(id, 2);
        }
    }
    Ok(())
}
fn filter_properties<'a>(filter: &'a Value, depth: usize, out: &mut Vec<&'a Value>) -> Res<()> {
    if filter.is_null() {
        return Ok(());
    }
    if depth > 64 {
        return Err("DRIVE:db_filter_schema".into());
    }
    match filter["kind"].as_str() {
        Some("predicate") => out.push(&filter["propertyId"]),
        Some("and" | "or") => {
            for child in filter["children"]
                .as_array()
                .ok_or("DRIVE:db_filter_schema")?
            {
                filter_properties(child, depth + 1, out)?;
            }
        }
        _ => return Err("DRIVE:db_filter_schema".into()),
    }
    Ok(())
}
pub fn validate(files: &Files) -> Res<()> {
    let mut records: BTreeMap<String, BTreeMap<String, Value>> = BTreeMap::new();
    let mut pages = BTreeMap::new();
    for (path, bytes) in files {
        if path.starts_with("pages/") {
            let page: Value = serde_json::from_slice(bytes).map_err(|_| "DRIVE:db_invalid_json")?;
            pages.insert(
                page["id"].as_str().ok_or("DRIVE:db_identity")?.to_string(),
                page,
            );
        }
        if path.starts_with("databases/") {
            let kind = path.split('/').nth(1).ok_or("DRIVE:db_identity")?;
            let record: Value =
                serde_json::from_slice(bytes).map_err(|_| "DRIVE:db_invalid_json")?;
            let id = record["id"]
                .as_str()
                .ok_or("DRIVE:db_identity")?
                .to_string();
            if records
                .entry(kind.into())
                .or_default()
                .insert(id, record)
                .is_some()
            {
                return Err("DRIVE:db_identity".into());
            }
        }
    }
    let check = |kind: &str, value: &Value| -> Res<()> {
        if value.is_null() {
            return Ok(());
        }
        let id = value
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("DRIVE:db_reference_invalid")?;
        let present = if kind == "pages" {
            pages.contains_key(id)
        } else {
            reference(&records, kind, id)
        };
        if !present {
            return Err("DRIVE:db_reference_missing".into());
        }
        Ok(())
    };
    for (kind, list) in &records {
        for record in list.values() {
            if !record["deletedAt"].is_null() {
                continue;
            }
            let refs: &[(&str, &str)] = match kind.as_str() {
                "containers" => &[("pages", "hostPageId")],
                "sources" => &[
                    ("containers", "ownerContainerId"),
                    ("properties", "titlePropertyId"),
                    ("templates", "defaultTemplateId"),
                ],
                "properties" => &[("sources", "sourceId")],
                "views" => &[
                    ("containers", "containerId"),
                    ("sources", "sourceId"),
                    ("views", "parentDashboardId"),
                    ("templates", "defaultTemplateId"),
                ],
                "relations" => &[
                    ("properties", "propertyId"),
                    ("sources", "sourceId"),
                    ("sources", "targetSourceId"),
                    ("properties", "inversePropertyId"),
                ],
                "edges" => &[
                    ("relations", "definitionId"),
                    ("pages", "fromPageId"),
                    ("pages", "toPageId"),
                ],
                "templates" => &[("sources", "sourceId")],
                "workflows" => &[
                    ("sources", "sourceId"),
                    ("views", "viewScopeId"),
                    ("properties", "propertyId"),
                ],
                "comments" => &[
                    ("pages", "pageId"),
                    ("properties", "propertyId"),
                    ("comments", "parentCommentId"),
                    ("principals", "authorId"),
                ],
                "grants" => &[
                    ("principals", "principalId"),
                    ("containers", "containerId"),
                    ("sources", "sourceId"),
                    ("pages", "pageId"),
                    ("properties", "propertyId"),
                    ("properties", "viaPropertyId"),
                ],
                "events" => &[("pages", "pageId"), ("principals", "principalId")],
                "allocators" => &[("sources", "sourceId"), ("properties", "propertyId")],
                _ => &[],
            };
            for (target, field) in refs {
                if let Some(value) = record.get(field) {
                    check(target, value)?;
                }
            }
            if kind == "sources" {
                if let Some(id) = record["titlePropertyId"].as_str() {
                    let p = &records["properties"][id];
                    if p.get("sourceId").is_some_and(|v| v != &record["id"])
                        || p.get("kind").is_some_and(|v| v != "title")
                    {
                        return Err("DRIVE:db_title_property_mismatch".into());
                    }
                }
            }
            if kind == "properties" {
                if record["kind"] == "relation" {
                    if let Some(id) = record["config"].get("definitionId") {
                        check("relations", id)?;
                    }
                }
                if record["kind"] == "rollup" {
                    for field in ["relationPropertyId", "targetPropertyId"] {
                        if let Some(id) = record["config"].get(field) {
                            check("properties", id)?;
                        }
                    }
                }
            }
            if kind == "views" {
                if let Some(parent) = record["parentDashboardId"].as_str() {
                    let dashboard = &records["views"][parent];
                    if dashboard.get("type").is_some_and(|v| v != "dashboard")
                        || record["type"] == "dashboard"
                    {
                        return Err("DRIVE:db_dashboard_schema".into());
                    }
                }
                let mut properties = vec![];
                if let Some(filter) = record.get("filter") {
                    filter_properties(filter, 0, &mut properties)?;
                }
                if let Some(sorts) = record.get("sorts").filter(|v| !v.is_null()) {
                    for sort in sorts.as_array().ok_or("DRIVE:db_filter_schema")? {
                        properties.push(&sort["propertyId"]);
                    }
                }
                for property in properties {
                    check("properties", property)?;
                    let id = property.as_str().ok_or("DRIVE:db_reference_invalid")?;
                    if !record["sourceId"].is_null()
                        && records["properties"][id]
                            .get("sourceId")
                            .is_some_and(|s| s != &record["sourceId"])
                    {
                        return Err("DRIVE:db_property_source_mismatch".into());
                    }
                }
            }
            if kind == "containers" {
                if let Some(links) = record.get("sourceLinks") {
                    for link in links.as_array().ok_or("DRIVE:db_reference_invalid")? {
                        check("sources", &link["sourceId"])?;
                    }
                }
            }
            if kind == "relations" {
                if let Some(ids) = record.get("displayedPropertyIds") {
                    for id in ids.as_array().ok_or("DRIVE:db_reference_invalid")? {
                        check("properties", id)?;
                    }
                }
            }
            if kind == "principals" {
                if let Some(ids) = record.get("memberIds") {
                    for id in ids.as_array().ok_or("DRIVE:db_reference_invalid")? {
                        check("principals", id)?;
                    }
                }
            }
            if kind == "comments" {
                if let Some(ids) = record.get("readBy") {
                    for id in ids.as_array().ok_or("DRIVE:db_reference_invalid")? {
                        check("principals", id)?;
                    }
                }
            }
            if kind == "templates" {
                if let Some(defaults) = record.get("defaults") {
                    for id in defaults
                        .as_object()
                        .ok_or("DRIVE:db_reference_invalid")?
                        .keys()
                    {
                        check("properties", &json!(id))?;
                    }
                }
                if let Some(nested) = record.get("nested") {
                    for item in nested.as_array().ok_or("DRIVE:db_reference_invalid")? {
                        check("sources", &item["sourceId"])?;
                        check("templates", &item["templateId"])?;
                    }
                }
            }
            if kind == "properties"
                && record["kind"] == "unique_id"
                && record["config"]["allocationMode"] == "sequential"
            {
                return Err("DRIVE:sequential_allocator_requires_partitioned".into());
            }
        }
    }
    let mut allocated = BTreeSet::new();
    for page in pages.values() {
        if !page["deletedAt"].is_null() {
            continue;
        }
        if let Some(row) = page.get("database") {
            if row["format"] != 1 {
                return Err("DRIVE:db_row_schema".into());
            }
            check("sources", &row["sourceId"])?;
            if let Some(parent) = row.get("parentItemId") {
                check("pages", parent)?;
            }
            if let Some(cells) = row.get("cells") {
                for (id, cell) in cells.as_object().ok_or("DRIVE:db_row_schema")? {
                    check("properties", &json!(id))?;
                    let property = &records["properties"][id];
                    if property
                        .get("sourceId")
                        .is_some_and(|s| s != &row["sourceId"])
                    {
                        return Err("DRIVE:db_property_source_mismatch".into());
                    }
                    if let Some(kind) = property["kind"].as_str() {
                        const CELL_KINDS: &[&str] = &[
                            "text",
                            "number",
                            "select",
                            "multi_select",
                            "status",
                            "date",
                            "people",
                            "files",
                            "checkbox",
                            "url",
                            "email",
                            "phone",
                            "place",
                            "verification",
                            "connected",
                        ];
                        if CELL_KINDS.contains(&kind) && cell["value"]["kind"] != kind {
                            return Err("DRIVE:db_cell_kind_mismatch".into());
                        }
                    }
                    if cell["value"]["kind"] == "people" {
                        if let Some(ids) = cell["value"].get("principalIds") {
                            for id in ids.as_array().ok_or("DRIVE:db_cell_schema")? {
                                check("principals", id)?;
                            }
                        }
                    }
                    if !cell["value"]["kind"].is_string() {
                        return Err("DRIVE:db_cell_schema".into());
                    }
                }
            }
            if let Some(parent) = row["parentItemId"].as_str() {
                if pages[parent]["database"]["sourceId"] != row["sourceId"] {
                    return Err("DRIVE:db_parent_source_mismatch".into());
                }
            }
            if let Some(values) = row.get("allocatedIds") {
                for (property, token) in values.as_object().ok_or("DRIVE:db_row_schema")? {
                    check("properties", &json!(property))?;
                    let token = token.as_str().ok_or("DRIVE:allocator_identity_collision")?;
                    if !allocated.insert((property.clone(), token.to_string())) {
                        return Err("DRIVE:allocator_identity_collision".into());
                    }
                }
            }
        }
    }
    let mut pairs = BTreeSet::new();
    let mut outgoing = BTreeSet::new();
    let mut incoming = BTreeSet::new();
    for edge in records
        .get("edges")
        .into_iter()
        .flat_map(|r| r.values())
        .filter(|e| e["deletedAt"].is_null())
    {
        if let (Some(definition), Some(from), Some(to)) = (
            edge["definitionId"].as_str(),
            edge["fromPageId"].as_str(),
            edge["toPageId"].as_str(),
        ) {
            let definition = &records["relations"][definition];
            let source = &pages[from]["database"]["sourceId"];
            let target = &pages[to]["database"]["sourceId"];
            if source != &definition["sourceId"] || target != &definition["targetSourceId"] {
                return Err("DRIVE:db_relation_source_mismatch".into());
            }
            if definition["mode"] == "self_symmetric"
                && (definition["sourceId"] != definition["targetSourceId"] || from > to)
            {
                return Err("DRIVE:db_symmetric_relation".into());
            }
            if !pairs.insert((edge["definitionId"].as_str().unwrap(), from, to)) {
                return Err("DRIVE:db_duplicate_edge".into());
            }
            if definition["mode"] != "self_symmetric"
                && definition["cardinality"] == "one"
                && !outgoing.insert((edge["definitionId"].as_str().unwrap(), from))
            {
                return Err("DRIVE:db_relation_cardinality".into());
            }
            if definition["mode"] != "self_symmetric"
                && definition["inverseCardinality"] == "one"
                && !incoming.insert((edge["definitionId"].as_str().unwrap(), to))
            {
                return Err("DRIVE:db_relation_cardinality".into());
            }
        }
    }
    reject_cycles(&pages, "/database/parentItemId")?;
    for (kind, pointer) in [
        ("views", "/parentDashboardId"),
        ("comments", "/parentCommentId"),
    ] {
        if let Some(records) = records.get(kind) {
            reject_cycles(records, pointer)?;
        }
    }
    Ok(())
}
#[derive(Serialize, Deserialize, Default)]
struct Migration {
    schema_version: u32,
    changes: BTreeMap<String, Change>,
}
#[derive(Serialize, Deserialize)]
struct Change {
    before: String,
    after: String,
    value: Value,
    committed: bool,
}
/// Called only after a verified full backup, under the Vault writer mutex.
/// Existing allocated IDs and record IDs are preserved; future allocations use device namespaces.
pub fn migrate_allocators(v: &Vault) -> Res<()> {
    let journal = v.root.join(".noviq/drive-allocator-migration.json");
    let mut migration: Migration = match fs::read(&journal) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| "DRIVE:allocator_migration_corrupt")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Migration {
            schema_version: 1,
            ..Default::default()
        },
        Err(e) => return Err(err(e)),
    };
    if migration.schema_version != 1 {
        return Err("DRIVE:allocator_migration_schema".into());
    }
    // Resume only exact before/after images; an unexpected third version is never overwritten.
    for (path, change) in migration
        .changes
        .iter()
        .filter(|(_, change)| !change.committed)
    {
        snapshot::checked_parents(&v.root, path)?;
        let current = fs::read(v.root.join(path)).map_err(err)?;
        let h = snapshot::hash(&current);
        if h != change.before && h != change.after {
            return Err("DRIVE:allocator_migration_changed".into());
        }
        if h == change.before {
            write_atomic(&v.root.join(path), &super::core::bytes(&change.value)?)?;
        }
    }
    for change in migration.changes.values_mut() {
        change.committed = true;
    }
    write_atomic(&journal, &super::core::bytes(&migration)?)?;
    for (path, data) in snapshot::read_metadata(v)? {
        if !path.starts_with("databases/properties/") {
            continue;
        }
        let mut value: Value = serde_json::from_slice(&data).map_err(err)?;
        if value["deletedAt"].is_null()
            && value["kind"] == "unique_id"
            && value["config"]["allocationMode"] == "sequential"
        {
            value["config"]["allocationMode"] = json!("partitioned");
            if let Some(revision) = value.get("revision") {
                let next = revision
                    .as_u64()
                    .and_then(|n| n.checked_add(1))
                    .ok_or("DRIVE:allocator_migration_schema")?;
                value["revision"] = json!(next);
            }
            value["updatedAt"] = json!(now_ms());
            value["lastOperationId"] = json!(format!(
                "drive-allocator-v1-{}",
                &snapshot::hash(&data)[..32]
            ));
            let bytes = super::core::bytes(&value)?;
            let before = fs::read(v.root.join(&path)).map_err(err)?;
            migration.changes.insert(
                path.clone(),
                Change {
                    before: snapshot::hash(&before),
                    after: snapshot::hash(&bytes),
                    value,
                    committed: false,
                },
            );
            write_atomic(&journal, &super::core::bytes(&migration)?)?;
            snapshot::checked_parents(&v.root, &path)?;
            write_atomic(&v.root.join(&path), &bytes)?;
            if snapshot::hash(&fs::read(v.root.join(&path)).map_err(err)?)
                != migration.changes[&path].after
            {
                return Err("DRIVE:allocator_migration_integrity".into());
            }
            migration.changes.get_mut(&path).unwrap().committed = true;
            write_atomic(&journal, &super::core::bytes(&migration)?)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn files(records: &[(&str, Value)]) -> Files {
        records
            .iter()
            .map(|(p, v)| (p.to_string(), super::super::core::bytes(v).unwrap()))
            .collect()
    }
    #[test]
    fn graph_rejects_dangling_reference_and_cross_source_cell() {
        let mut f = files(&[
            ("databases/sources/s.json", json!({"id":"s"})),
            (
                "databases/properties/p.json",
                json!({"id":"p","sourceId":"s"}),
            ),
            (
                "pages/a.json",
                json!({"id":"a","database":{"format":1,"sourceId":"s","cells":{"p":{"value":{"kind":"text","value":"x"}}}}}),
            ),
        ]);
        validate(&f).unwrap();
        f.remove("databases/properties/p.json");
        assert_eq!(validate(&f).unwrap_err(), "DRIVE:db_reference_missing");
        f.insert(
            "databases/sources/other.json".into(),
            super::super::core::bytes(&json!({"id":"other"})).unwrap(),
        );
        f.insert(
            "databases/properties/p.json".into(),
            super::super::core::bytes(&json!({"id":"p","sourceId":"other"})).unwrap(),
        );
        assert_eq!(
            validate(&f).unwrap_err(),
            "DRIVE:db_property_source_mismatch"
        );
    }
    #[test]
    fn duplicate_allocated_tokens_fail_before_application() {
        let mut f = files(&[
            ("databases/sources/s.json", json!({"id":"s"})),
            (
                "databases/properties/p.json",
                json!({"id":"p","sourceId":"s","kind":"unique_id","config":{"allocationMode":"partitioned"}}),
            ),
        ]);
        for id in ["a", "b"] {
            f.insert(format!("pages/{id}.json"),super::super::core::bytes(&json!({"id":id,"database":{"format":1,"sourceId":"s","allocatedIds":{"p":"device-a:1"}}})).unwrap());
        }
        assert_eq!(
            validate(&f).unwrap_err(),
            "DRIVE:allocator_identity_collision"
        );
    }
    #[test]
    fn sequential_migration_is_idempotent_and_preserves_allocated_values() {
        let root = std::env::temp_dir().join(format!("nevis-allocator-{}", uuid::Uuid::new_v4()));
        let v = Vault::create(root.clone(), "Test").unwrap();
        let property = "databases/properties/p.json";
        let original = json!({"format":1,"id":"p","sourceId":"s","kind":"unique_id","revision":7,"config":{"allocationMode":"sequential","prefix":"OLD"}});
        write_atomic(
            &root.join(property),
            &super::super::core::bytes(&original).unwrap(),
        )
        .unwrap();
        let row=super::super::core::bytes(&json!({"id":v.id(),"title":"row","database":{"format":1,"sourceId":"s","allocatedIds":{"p":"OLD-42"}},"content":{"type":"doc","content":[]}})).unwrap();
        write_atomic(&root.join(format!("pages/{}.json", v.id())), &row).unwrap();
        migrate_allocators(&v).unwrap();
        let after = fs::read(root.join(property)).unwrap();
        let changed: Value = serde_json::from_slice(&after).unwrap();
        assert_eq!(changed["id"], "p");
        assert_eq!(changed["revision"], 8);
        assert_eq!(changed["config"]["allocationMode"], "partitioned");
        assert_eq!(changed["config"]["prefix"], "OLD");
        migrate_allocators(&v).unwrap();
        assert_eq!(fs::read(root.join(property)).unwrap(), after);
        assert_eq!(
            fs::read(root.join(format!("pages/{}.json", v.id()))).unwrap(),
            row
        );
        drop(v);
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod graph_tests {
    use super::*;
    fn bytes_of(value: Value) -> Vec<u8> {
        super::super::core::bytes(&value).unwrap()
    }
    fn put(f: &mut Files, path: &str, value: Value) {
        f.insert(path.into(), bytes_of(value));
    }
    fn graph() -> Files {
        let mut f = Files::new();
        put(&mut f, "databases/sources/s.json", json!({"id":"s"}));
        put(
            &mut f,
            "databases/properties/p.json",
            json!({"id":"p","sourceId":"s","kind":"number"}),
        );
        for id in ["a", "b", "c"] {
            put(
                &mut f,
                &format!("pages/{id}.json"),
                json!({"id":id,"database":{"format":1,"sourceId":"s","parentItemId":null,"cells":{}}}),
            );
        }
        put(
            &mut f,
            "databases/relations/r.json",
            json!({"id":"r","sourceId":"s","targetSourceId":"s","cardinality":"one","inverseCardinality":"many","mode":"one_way"}),
        );
        f
    }
    #[test]
    fn relation_limits_and_logical_duplicate_edges_are_rejected() {
        let mut f = graph();
        put(
            &mut f,
            "databases/edges/e1.json",
            json!({"id":"e1","definitionId":"r","fromPageId":"a","toPageId":"b"}),
        );
        validate(&f).unwrap();
        put(
            &mut f,
            "databases/edges/e2.json",
            json!({"id":"e2","definitionId":"r","fromPageId":"a","toPageId":"c"}),
        );
        assert_eq!(validate(&f).unwrap_err(), "DRIVE:db_relation_cardinality");
        put(
            &mut f,
            "databases/edges/e2.json",
            json!({"id":"e2","definitionId":"r","fromPageId":"a","toPageId":"b"}),
        );
        assert_eq!(validate(&f).unwrap_err(), "DRIVE:db_duplicate_edge");
    }
    #[test]
    fn parent_cycles_and_cross_kind_cells_are_never_applied() {
        let mut f = graph();
        put(
            &mut f,
            "pages/a.json",
            json!({"id":"a","database":{"format":1,"sourceId":"s","parentItemId":"b","cells":{}}}),
        );
        put(
            &mut f,
            "pages/b.json",
            json!({"id":"b","database":{"format":1,"sourceId":"s","parentItemId":"a","cells":{}}}),
        );
        assert_eq!(validate(&f).unwrap_err(), "DRIVE:db_parent_cycle");
        put(
            &mut f,
            "pages/a.json",
            json!({"id":"a","database":{"format":1,"sourceId":"s","cells":{"p":{"value":{"kind":"text","runs":[]}}}}}),
        );
        assert_eq!(validate(&f).unwrap_err(), "DRIVE:db_cell_kind_mismatch");
    }
    #[test]
    fn view_filter_and_dashboard_references_follow_the_actual_schema() {
        let mut f = graph();
        put(
            &mut f,
            "databases/views/d.json",
            json!({"id":"d","type":"dashboard"}),
        );
        put(
            &mut f,
            "databases/views/v.json",
            json!({"id":"v","type":"table","sourceId":"s","parentDashboardId":"d","filter":{"kind":"and","children":[{"kind":"predicate","propertyId":"p","op":"is_empty"}]},"sorts":[{"propertyId":"p","direction":"asc"}]}),
        );
        validate(&f).unwrap();
        put(
            &mut f,
            "databases/views/d.json",
            json!({"id":"d","type":"table"}),
        );
        assert_eq!(validate(&f).unwrap_err(), "DRIVE:db_dashboard_schema");
        put(
            &mut f,
            "databases/views/d.json",
            json!({"id":"d","type":"dashboard"}),
        );
        f.remove("databases/properties/p.json");
        assert_eq!(validate(&f).unwrap_err(), "DRIVE:db_reference_missing");
    }
}

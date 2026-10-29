#!/usr/bin/env python3
"""Generate the 104-case matrix only from observed named test results, never assumed PASS."""
import argparse, collections, json, pathlib, re
parser=argparse.ArgumentParser()
parser.add_argument('--cargo-log', action='append', required=True)
parser.add_argument('--output', default='docs/sync/drive/TEST_MATRIX.md')
args=parser.parse_args()
results={}
for log in args.cargo_log:
    for name,status in re.findall(r'^test (\S+) \.\.\. (ok|FAILED|ignored)',pathlib.Path(log).read_text(),re.M):
        results[name]=status
prefix='sync::drive::tests::'
# Only cases with assertions representing the stated scenario are mapped. Partial evidence is not PASS.
mapping={
'L04':['local_changed_during_http_does_not_overwrite'],
'A06':['@sync::drive::roots::tests::duplicate_names_require_explicit_verified_identity_and_never_fall_back','@sync::drive::roots::tests::choice_is_account_scoped_and_bound_vaults_cannot_be_redirected'],
'A10':['@sync::drive::transport::refresh_tests::repeated_401_and_revoked_refresh_are_bounded_and_redacted'],
'B03':['concurrent_single_relation_links_require_a_reviewed_atomic_decision','@sync::drive::database::graph_tests::relation_limits_and_logical_duplicate_edges_are_rejected'],
'C10':['@sync::drive::history::tests::restore_copy_preserves_original_identity_and_contents_and_has_its_own_name','@sync::drive::history::tests::preview_counts_inventory_without_claiming_full_restore_verification'],
'L06':['@vault::locking_tests::another_process_cannot_open_until_every_local_handle_is_closed'],
'L08':['vanished_vault_never_recreates_or_publishes_deletes'],
'L10':['immutable_publish_unknown_response_and_restart_100_times'],
'P02':['immutable_publish_unknown_response_and_restart_100_times','@sync::drive::transport::multipart_tests::marker_lost_response_reconciles_reserved_id_without_second_create'],
'P03':['immutable_publish_unknown_response_and_restart_100_times','no_changes_produces_zero_remote_writes'],
'P04':['reject_schema_hash_and_device_sequence_collision'],
'P05':['reject_schema_hash_and_device_sequence_collision'],
'P06':['missing_asset_defers_entire_apply_and_preserves_inbox_log'],
'P09':['no_changes_produces_zero_remote_writes'],
'P10':['capture_coalesces_1000_raw_local_edits'],
'D02':['paginated_changes_failure_keeps_durable_inbox_before_advancing_cursor'],
'D03':['expired_cursor_rescans_but_missing_uncovered_history_stops_without_deletion'],
'D07':['expired_cursor_rescans_but_missing_uncovered_history_stops_without_deletion'],
'D09':['one_hundred_causal_batches_converge_across_twenty_incremental_arrival_orders'],
'D04':['no_changes_produces_zero_remote_writes'],
'D08':['two_devices_independent_fields_and_cold_restore'],
'D10':['immutable_publish_unknown_response_and_restart_100_times'],
'M01':['two_devices_independent_fields_and_cold_restore'],
'M02':['same_block_conflict_and_resolution_is_durable'],
'M03':['simultaneous_inserts_keep_both_in_deterministic_order_without_conflict'],
'M04':['moved_block_and_offline_text_edit_merge_across_parents'],
'M05':['concurrent_moves_have_one_identity_and_both_parent_candidates'],
'M06':['parent_delete_and_child_append_restore_valid_ancestors_with_archive'],
'M10':['tree_roundtrip_preserves_rich_text_and_reserved_unknown_fields'],
'M11':['legacy_migration_is_deterministic_without_existing_ids'],
'B01':['database_fields_merge_and_same_field_archives_keep_original_identity'],
'B02':['database_fields_merge_and_same_field_archives_keep_original_identity'],
'B05':['@sync::drive::database::tests::duplicate_allocated_tokens_fail_before_application','database_same_identity_creation_archives_whole_candidates_and_delete_edit_resurrects'],
'B07':['global_theme_syncs_but_device_local_font_never_enters_cloud_or_checkpoint','switching_settings_back_to_global_preserves_and_publishes_local_value'],
'B10':['expired_cursor_rescans_but_missing_uncovered_history_stops_without_deletion'],
'B11':['checkpoint_gc_retains_object_only_referenced_by_older_history','late_reference_restores_deleted_historical_asset_after_checkpoint_pruning'],
'B08':['page_delete_offline_edit_resurrects_and_archives'],
'C04':['two_devices_independent_fields_and_cold_restore','benchmark_1000_pages_1000_assets_cold_restore','all_13_record_types_retain_identity_and_field_values'],
'C03':['@sync::drive::checkpoint::tests::incomparable_checkpoints_never_choose_the_latest_timestamp'],
'C05':['checkpoint_tail_preserves_offline_preimage_and_new_device_sequence','checkpoint_late_lower_actor_and_three_candidates_match_full_replay'],
'C06':['stale_device_without_edits_rebootstraps_after_covered_stream_removal'],
'C07':['@vault::locking_tests::drive_marker_fences_legacy_open_without_changing_logical_identity'],
'C09':['gc_proof_is_durable_stale_sensitive_and_never_deletes_without_release_gates','checkpoint_gc_retains_object_only_referenced_by_older_history'],
'U06':['independent_changes_continue_syncing_while_another_conflict_remains_open'],
'C13':['@sync::drive::checkpoint::tests::manifest_hash_paths_and_tamper_rejected'],
'C14':['empty_remote_bootstrap_is_not_a_valid_empty_vault','two_devices_independent_fields_and_cold_restore'],
}
source=pathlib.Path('docs/sync/drive/EXECUTION_PLAN_FA.md').read_text()
rows=re.findall(r'^\| ([LAPDMBCU]\d{2}) \| (.*?) \| (.*?) \|',source,re.M)
rows=[(i,s,e) for i,s,e in rows if len(i)==3 and i[0] in 'LAPDMBCU']
assert len(rows)==104, len(rows)
counts=collections.Counter(); out=[]
for id,scenario,expected in rows:
    names=[name[1:] if name.startswith('@') else prefix+name for name in mapping.get(id,[])]
    statuses=[results.get(name) for name in names]
    status='FAIL' if 'FAILED' in statuses else 'PASS' if names and all(s=='ok' for s in statuses) else 'NOT_RUN'
    counts[status]+=1
    evidence='<br>'.join('`'+n+'`' for n in names) if names else 'No complete automated/live assertion for this acceptance case; see limitations.'
    out.append(f'| {id} | {scenario} | {status} | {evidence} |')
text='# Acceptance matrix — computed from test logs\n\n'+', '.join(f'{k}: {counts[k]}' for k in ['PASS','FAIL','NOT_RUN'])+'; total: 104.\n\nPASS means the named synthetic test ran. It does not establish live Google or OS compatibility. NOT_RUN includes internal implementation/test gaps as well as external dependencies.\n\n| ID | Scenario from plan | Result | Evidence / limit |\n|---|---|---|---|\n'+'\n'.join(out)+'\n'
pathlib.Path(args.output).write_text(text)
pathlib.Path(args.output).with_suffix('.json').write_text(json.dumps({'counts':{k:counts[k] for k in ['PASS','FAIL','NOT_RUN']},'total':104,'testResults':results},indent=2)+'\n')
print(dict(counts))

# Acceptance matrix — computed from test logs

PASS: 42, FAIL: 0, NOT_RUN: 62; total: 104.

PASS means the named synthetic test ran. It does not establish live Google or OS compatibility. NOT_RUN includes internal implementation/test gaps as well as external dependencies.

| ID | Scenario from plan | Result | Evidence / limit |
|---|---|---|---|
| L01 | برنامه حین تایپ قبل از flush UI بسته شود | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| L02 | Crash بعد از local write و قبل از outbox insert | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| L03 | Crash وسط نوشتن journal/outbox | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| L04 | تغییر صفحه حین HTTP upload قبلی | PASS | `sync::drive::tests::local_changed_during_http_does_not_overwrite` |
| L05 | worker هم‌زمان از timer و Sync Now | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| L06 | دو process یک Vault را باز کنند | PASS | `vault::locking_tests::another_process_cannot_open_until_every_local_handle_is_closed` |
| L07 | filesystem full/read-only | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| L08 | Vault path ناپدید شود | PASS | `sync::drive::tests::vanished_vault_never_recreates_or_publishes_deletes` |
| L09 | unexpected local file edit از ابزار خارجی | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| L10 | retry بعد از restart با outbox persist‌شده | PASS | `sync::drive::tests::immutable_publish_unknown_response_and_restart_100_times` |
| A01 | login cancel/timeout | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A02 | refresh token منقضی/revoked | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A03 | OS Keychain unavailable | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A04 | دو حساب Google مختلف | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A05 | فایل/فولدر renamed در Drive | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A06 | دو فولدر `Nevis` هم‌نام | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A07 | cross-device `drive.file` discovery | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A08 | permission removed / root deleted | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A09 | quota 403/429 و `Retry-After` | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A10 | 401 refresh لازم / refresh هم شکست | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A11 | 5xx / network timeout / TLS error | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A12 | Drive storage full و 403 insufficient storage | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A13 | پاسخ API بسیار کند | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| A14 | app در OAuth Testing/Production | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| P01 | Upload asset موفق، batch fail | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| P02 | Upload batch موفق، response گم‌شده | PASS | `sync::drive::tests::immutable_publish_unknown_response_and_restart_100_times`<br>`sync::drive::transport::multipart_tests::marker_lost_response_reconciles_reserved_id_without_second_create` |
| P03 | تکرار same batch N بار | PASS | `sync::drive::tests::immutable_publish_unknown_response_and_restart_100_times`<br>`sync::drive::tests::no_changes_produces_zero_remote_writes` |
| P04 | batchId یکسان با payload متفاوت | PASS | `sync::drive::tests::reject_schema_hash_and_device_sequence_collision` |
| P05 | Device ID/sequence collision | PASS | `sync::drive::tests::reject_schema_hash_and_device_sequence_collision` |
| P06 | batch کامل اما required asset مفقود | PASS | `sync::drive::tests::missing_asset_defers_entire_apply_and_preserves_inbox_log` |
| P07 | media truncation و incorrect SHA | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| P08 | gzip bomb / oversized JSON / deep nesting | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| P09 | 0 changes + Sync Now | PASS | `sync::drive::tests::no_changes_produces_zero_remote_writes` |
| P10 | هزاران تغییر یک بلاک در 60 ثانیه | PASS | `sync::drive::tests::capture_coalesces_1000_raw_local_edits` |
| P11 | فاصله غیرعادی timestamp device | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| P12 | remote asset با same hash/metadata name ولی bytes متفاوت | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| D01 | تغییر در فاصله initial startToken و full inventory | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| D02 | `changes.list` چند صفحه + crash وسط pagination | PASS | `sync::drive::tests::paginated_changes_failure_keeps_durable_inbox_before_advancing_cursor` |
| D03 | invalid/expired changes token | PASS | `sync::drive::tests::expired_cursor_rescans_but_missing_uncovered_history_stops_without_deletion` |
| D04 | same change item دوبار گزارش شود | PASS | `sync::drive::tests::no_changes_produces_zero_remote_writes` |
| D05 | batch seq 10 قبل از seq 9 برسد | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| D06 | prevBatchId نادرست | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| D07 | `removed` در Drive feed | PASS | `sync::drive::tests::expired_cursor_rescans_but_missing_uncovered_history_stops_without_deletion` |
| D08 | دستگاه A و B concurrent publishes | PASS | `sync::drive::tests::two_devices_independent_fields_and_cold_restore` |
| D09 | arbitrary ordering of 100 batches | PASS | `sync::drive::tests::one_hundred_causal_batches_converge_across_twenty_incremental_arrival_orders` |
| D10 | duplicate requests بعد از recovery | PASS | `sync::drive::tests::immutable_publish_unknown_response_and_restart_100_times` |
| D11 | permission changes وسط download | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| D12 | فایل ناشناخته/آلوده توسط کاربر در Nevis folder | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| M01 | A عنوان page، B یک paragraph دیگر را تغییر دهد | PASS | `sync::drive::tests::two_devices_independent_fields_and_cold_restore` |
| M02 | A/B متن یک بلاک را هم‌زمان و متفاوت عوض کنند | PASS | `sync::drive::tests::same_block_conflict_and_resolution_is_durable` |
| M03 | دو insert concurrent در یک index | PASS | `sync::drive::tests::simultaneous_inserts_keep_both_in_deterministic_order_without_conflict` |
| M04 | move یک بلاک + edit همان بلاک | PASS | `sync::drive::tests::moved_block_and_offline_text_edit_merge_across_parents` |
| M05 | دو move concurrent به ستون‌های متفاوت | PASS | `sync::drive::tests::concurrent_moves_have_one_identity_and_both_parent_candidates` |
| M06 | delete parent + append child | PASS | `sync::drive::tests::parent_delete_and_child_append_restore_valid_ancestors_with_archive` |
| M07 | افزودن ستون + تغییر محتوا در ستون دیگر | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| M08 | copy/paste یا duplicate صفحه | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| M09 | undo/redo بعد از incoming update | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| M10 | schema/plugin node ناشناخته | PASS | `sync::drive::tests::tree_roundtrip_preserves_rich_text_and_reserved_unknown_fields` |
| M11 | legacy page بدون block IDs | PASS | `sync::drive::tests::legacy_migration_is_deterministic_without_existing_ids` |
| M12 | Rich Text marks/links/task/equations/images | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| M13 | concurrent metadata key changes | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| M14 | page-level replace-safe + concurrent block change | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| B01 | A یک property، B یک field دیگر همان record را edit کند | PASS | `sync::drive::tests::database_fields_merge_and_same_field_archives_keep_original_identity` |
| B02 | دو edit ناسازگار یک field | PASS | `sync::drive::tests::database_fields_merge_and_same_field_archives_keep_original_identity` |
| B03 | concurrent relation/edge updates | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| B04 | atomic multi-record batch و crash وسط apply | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| B05 | ID allocation هم‌زمان روی دو دستگاه | PASS | `sync::drive::database::tests::duplicate_allocated_tokens_fail_before_application`<br>`sync::drive::tests::database_same_identity_creation_archives_whole_candidates_and_delete_edit_resurrects` |
| B06 | kv stale UI cache بعد از remote update | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| B07 | theme global و font size device-local | PASS | `sync::drive::tests::global_theme_syncs_but_device_local_font_never_enters_cloud_or_checkpoint`<br>`sync::drive::tests::switching_settings_back_to_global_preserves_and_publishes_local_value` |
| B08 | A page delete، B offline edit همان page | PASS | `sync::drive::tests::page_delete_offline_edit_resurrects_and_archives` |
| B09 | دو delete موازی یک صفحه | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| B10 | Remote file vanished بدون tombstone | PASS | `sync::drive::tests::expired_cursor_rescans_but_missing_uncovered_history_stops_without_deletion` |
| B11 | صفحه با asset reference در conflict/history | PASS | `sync::drive::tests::checkpoint_gc_retains_object_only_referenced_by_older_history` |
| B12 | page permanent-delete UI و offline device | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| C01 | Crash وسط checkpoint objects upload | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| C02 | manifest published ولی object missing | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| C03 | دو concurrent checkpoints با incomparable frontiers | PASS | `sync::drive::checkpoint::tests::incomparable_checkpoints_never_choose_the_latest_timestamp` |
| C04 | fresh device از remote خالی محلی | PASS | `sync::drive::tests::two_devices_independent_fields_and_cold_restore`<br>`sync::drive::tests::benchmark_1000_pages_1000_assets_cold_restore`<br>`sync::drive::tests::all_13_record_types_retain_identity_and_field_values` |
| C05 | device offline یک ماه ویرایش کرده | PASS | `sync::drive::tests::checkpoint_tail_preserves_offline_preimage_and_new_device_sequence` |
| C06 | device offline بدون ویرایش و GC شده | PASS | `sync::drive::tests::stale_device_without_edits_rebootstraps_after_covered_stream_removal` |
| C07 | legacy older client incompatible protocol | PASS | `vault::locking_tests::drive_marker_fences_legacy_open_without_changing_logical_identity` |
| C08 | GC crash بعد از حذف بخشی از candidates | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| C09 | GC dry-run به object reference مهم می‌رسد | PASS | `sync::drive::tests::gc_proof_is_durable_stale_sensitive_and_never_deletes_without_release_gates`<br>`sync::drive::tests::checkpoint_gc_retains_object_only_referenced_by_older_history` |
| C10 | restoration of an older History checkpoint | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| C11 | checkpoint with 1000 pages + 1000 assets | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| C12 | local backup restored روی دستگاه دوم | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| C13 | manifest tampering/corrupt inventory | PASS | `sync::drive::checkpoint::tests::manifest_hash_paths_and_tamper_rejected` |
| C14 | no valid checkpoint left | PASS | `sync::drive::tests::empty_remote_bootstrap_is_not_a_valid_empty_vault`<br>`sync::drive::tests::two_devices_independent_fields_and_cold_restore` |
| U01 | Vault قبلی GitHub به Drive migrate شود | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U02 | provider switch while pending outbox | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U03 | disconnected Drive | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U04 | Preview & Release نصب کنار هم | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U05 | Sync status changes during upload | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U06 | Conflict unresolved but independent file changed | PASS | `sync::drive::tests::independent_changes_continue_syncing_while_another_conflict_remains_open` |
| U07 | simulate 10k blocks / 10k changes | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U08 | large media upload interrupted then resumed | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U09 | file path traversal / case collision | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U10 | token/content appear in logs | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U11 | external Drive rename/move Nevis folder | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U12 | Drive API rate limit prolonged 24h | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U13 | no change for 8h app open | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U14 | several Vaults | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U15 | export + clean reinstall + import | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |
| U16 | Reconnect after logout/account switched | NOT_RUN | No complete automated/live assertion for this acceptance case; see limitations. |

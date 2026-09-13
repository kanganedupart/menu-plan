(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.createBareunBackupArchive = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBareunBackupArchive(options) {
  'use strict';
  options = options || {};
  const env = typeof globalThis !== 'undefined' ? globalThis : {};
  const indexedDB = options.indexedDB || env.indexedDB;
  const crypto = options.crypto || env.crypto;
  const Encoder = options.TextEncoder || env.TextEncoder;
  const dbName = options.dbName || 'bareun_backup_archive_v1';
  const storeName = 'raw_backups';
  const legacyKey = 'bareun_v11_backups';
  let opening = null;
  const previews = new Map();
  let previewSequence = 0;
  let runtimeOpening = null;
  const runtimeDbName = dbName + '__runtime_v1';
  const runtimeLimit = 30;
  const runtimeByteLimit = 16 * 1024 * 1024;

  function fail(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
  async function hashRaw(raw) {
    if (typeof raw !== 'string') throw fail('백업 원문은 문자열이어야 합니다.', 'INVALID_RAW');
    if (!crypto || !crypto.subtle || typeof Encoder !== 'function') {
      throw fail('SHA-256 검증을 사용할 수 없습니다.', 'HASH_UNAVAILABLE');
    }
    const hash = await crypto.subtle.digest('SHA-256', new Encoder().encode(raw));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function open() {
    if (opening) return opening;
    const promise = new Promise((resolve, reject) => {
      if (!indexedDB) { reject(fail('IndexedDB를 사용할 수 없습니다.', 'IDB_UNAVAILABLE')); return; }
      let request;
      try { request = indexedDB.open(dbName, 1); }
      catch (error) { reject(error); return; }
      let settled = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: 'sha256' });
      };
      request.onerror = () => { settled = true; reject(request.error || fail('백업 저장소 열기 실패', 'OPEN_FAILED')); };
      request.onblocked = () => { settled = true; reject(fail('다른 창이 백업 저장소 변경을 막고 있습니다.', 'OPEN_BLOCKED')); };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
    });
    opening = promise;
    promise.catch(() => { if (opening === promise) opening = null; });
    return promise;
  }
  async function readRecord(sha256) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let value;
      let tx;
      try {
        tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).get(sha256);
        request.onsuccess = () => { value = request.result; };
      } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(tx.error || fail('백업 다시 읽기 실패', 'READ_FAILED'));
    });
  }
  async function verifyRecord(sha256, expectedRaw) {
    const record = await readRecord(sha256);
    if (!record || record.sha256 !== sha256 || typeof record.raw !== 'string') {
      throw fail('보관한 백업 원문을 다시 찾지 못했습니다.', 'ARCHIVE_MISSING');
    }
    const actual = await hashRaw(record.raw);
    if (actual !== sha256 || (expectedRaw !== undefined && record.raw !== expectedRaw)) {
      throw fail('보관 백업의 해시 또는 원문이 일치하지 않습니다.', 'VERIFY_FAILED');
    }
    return record;
  }
  async function insertUnlessPresent(record) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let deduplicated = false;
      let tx;
      try {
        tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.get(record.sha256);
        request.onsuccess = () => {
          if (request.result !== undefined) deduplicated = true;
          else store.add(record);
        };
      } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(deduplicated);
      tx.onabort = tx.onerror = () => reject(tx.error || fail('백업 보관이 완료되지 않았습니다.', 'WRITE_FAILED'));
    });
  }
  async function archiveRaw(raw, source) {
    const sha256 = await hashRaw(raw);
    const deduplicated = await insertUnlessPresent({
      sha256: sha256,
      raw: raw,
      source: typeof source === 'string' ? source : 'new_backup',
      createdAt: new Date().toISOString(),
      schemaVersion: 1
    });
    // Resolve only after write transaction completion AND independent read/hash verification.
    const record = await verifyRecord(sha256, raw);
    return { sha256: sha256, key: sha256, verified: true, deduplicated: deduplicated, raw: record.raw, createdAt: record.createdAt };
  }
  async function archiveLegacy() {
    const storage = options.localStorage || env.localStorage;
    if (!storage || typeof storage.getItem !== 'function') throw fail('기존 백업을 읽을 수 없습니다.', 'LEGACY_READ_UNAVAILABLE');
    // Read only: never setItem, removeItem, clear, truncate, or parse/reserialize the legacy value.
    const raw = storage.getItem(legacyKey);
    if (raw === null) return { status: 'missing', legacyKey: legacyKey, verified: false };
    return Object.assign({ status: 'archived', legacyKey: legacyKey }, await archiveRaw(raw, legacyKey));
  }
  async function exportRaw(sha256) {
    if (!/^[a-f0-9]{64}$/.test(String(sha256 || ''))) throw fail('유효한 백업 SHA-256이 필요합니다.', 'INVALID_KEY');
    return (await verifyRecord(sha256)).raw;
  }
  async function previewLegacyCompaction(settings) {
    settings = settings || {};
    const mode = settings.mode || 'keep_latest';
    if (mode !== 'keep_latest' && mode !== 'empty') throw fail('허용되지 않은 백업 축소 방식입니다.', 'INVALID_MODE');
    const storage = options.localStorage || env.localStorage;
    const raw = storage.getItem(legacyKey);
    if (raw === null) throw fail('축소할 기존 백업이 없습니다.', 'LEGACY_MISSING');
    let values;
    try { values = JSON.parse(raw); } catch (_) { throw fail('기존 백업 형식을 확인할 수 없습니다.', 'UNKNOWN_LEGACY_FORMAT'); }
    if (!Array.isArray(values) || !values.every(value => value && typeof value === 'object' &&
      Number.isFinite(value.at) && typeof value.reason === 'string' && value.state &&
      typeof value.state === 'object' && !Array.isArray(value.state) && value.state.plan &&
      typeof value.state.plan === 'object' && !Array.isArray(value.state.plan))) {
      throw fail('알려진 바른 백업 배열 형식이 아니므로 축소하지 않습니다.', 'UNKNOWN_LEGACY_FORMAT');
    }
    // Existing app appends with push and keeps slice(-30): last entry is the latest insertion.
    const retained = mode === 'empty' ? [] : values.slice(-1);
    const replacementRaw = JSON.stringify(retained);
    const sha256 = await hashRaw(raw);
    const replacementSha256 = await hashRaw(replacementRaw);
    const token = sha256 + ':' + (++previewSequence);
    if (previews.size >= 8) previews.delete(previews.keys().next().value);
    previews.set(token, { raw: raw, replacementRaw: replacementRaw, sha256: sha256,
      replacementSha256: replacementSha256, mode: mode, inFlight: null });
    return Object.freeze({ token: token, legacyKey: legacyKey, mode: mode, expectedRawSha256: sha256,
      replacementSha256: replacementSha256, beforeCount: values.length, afterCount: retained.length,
      beforeCharacters: raw.length, afterCharacters: replacementRaw.length,
      changesRaw: raw !== replacementRaw, requiresStoppedIsolatedMaintenance: true });
  }
  async function commitLegacyCompaction(previewToken, settings) {
    settings = settings || {};
    if (settings.isolatedMaintenance !== true || settings.legacyAppStopped !== true) {
      throw fail('기존 앱이 정지된 격리 유지보수 확인이 필요합니다.', 'MAINTENANCE_REQUIRED');
    }
    const preview = previews.get(previewToken);
    if (!preview || settings.expectedRawSha256 !== preview.sha256) {
      throw fail('확인한 백업 원문 해시와 미리보기가 일치하지 않습니다.', 'PREVIEW_MISMATCH');
    }
    if (preview.inFlight) return preview.inFlight;
    const work = (async () => {
      const storage = options.localStorage || env.localStorage;
      let current = storage.getItem(legacyKey);
      if (current !== preview.raw && current !== preview.replacementRaw) {
        throw fail('미리보기 이후 기존 백업이 변경되어 중단합니다.', 'LEGACY_CHANGED');
      }
      if (await hashRaw(preview.raw) !== settings.expectedRawSha256) throw fail('미리보기 원문 검증 실패', 'PREVIEW_MISMATCH');
      // Archive and independent hash/readback must finish BEFORE any localStorage mutation.
      const archived = await archiveRaw(preview.raw, legacyKey);
      current = storage.getItem(legacyKey);
      if (current === preview.replacementRaw) {
        return { status: 'already_compacted', archiveSha256: archived.sha256, verified: true,
          replacementSha256: preview.replacementSha256, localStorageWritten: false };
      }
      if (current !== preview.raw || await hashRaw(current) !== settings.expectedRawSha256) {
        throw fail('보관 중 기존 백업이 변경되어 중단합니다.', 'LEGACY_CHANGED');
      }
      // Final synchronous compare immediately before a single-key write. This is NOT cross-tab CAS.
      if (storage.getItem(legacyKey) !== preview.raw) throw fail('쓰기 직전 백업이 변경되었습니다.', 'LEGACY_CHANGED');
      storage.setItem(legacyKey, preview.replacementRaw);
      const after = storage.getItem(legacyKey);
      if (after !== preview.replacementRaw || await hashRaw(after) !== preview.replacementSha256 ||
          storage.getItem(legacyKey) !== preview.replacementRaw) {
        const error = fail('축소 후 값이 달라졌습니다. 자동 원복 없이 보관 원문을 확인해야 합니다.', 'POST_WRITE_CHANGED');
        error.archiveSha256 = archived.sha256;
        throw error;
      }
      return { status: 'compacted', archiveSha256: archived.sha256, verified: true,
        replacementSha256: preview.replacementSha256, localStorageWritten: true };
    })();
    preview.inFlight = work;
    try { return await work; } finally { if (preview.inFlight === work) preview.inFlight = null; }
  }
  function openRuntime() {
    if (runtimeOpening) return runtimeOpening;
    const promise = new Promise((resolve, reject) => {
      if (!indexedDB) { reject(fail('IndexedDB를 사용할 수 없습니다.', 'IDB_UNAVAILABLE')); return; }
      let request, settled = false;
      try { request = indexedDB.open(runtimeDbName, 1); } catch (error) { reject(error); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        ['snapshots', 'staging'].forEach(name => { if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'sha256' }); });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      request.onerror = () => { settled = true; reject(request.error || fail('실행 백업 저장소 열기 실패', 'OPEN_FAILED')); };
      request.onblocked = () => { settled = true; reject(fail('실행 백업 저장소 열기가 차단되었습니다.', 'OPEN_BLOCKED')); };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        db.onversionchange = () => { db.close(); runtimeOpening = null; };
        resolve(db);
      };
    });
    runtimeOpening = promise;
    promise.catch(() => { if (runtimeOpening === promise) runtimeOpening = null; });
    return promise;
  }
  async function runtimeTransaction(names, mode, enqueue) {
    const db = await openRuntime();
    return new Promise((resolve, reject) => {
      let tx, result, explicitError;
      try {
        tx = db.transaction(names, mode);
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(explicitError || tx.error || fail('실행 백업 transaction 실패', 'RUNTIME_TRANSACTION_FAILED'));
        enqueue(tx, value => { result = value; }, error => { explicitError = error; tx.abort(); });
      } catch (error) { reject(error); }
    });
  }
  async function runtimeRead(storeName, sha256) {
    return runtimeTransaction([storeName], 'readonly', (tx, done) => {
      const request = tx.objectStore(storeName).get(sha256);
      request.onsuccess = () => done(request.result);
    });
  }
  async function archiveRuntimeRaw(raw, source) {
    const sha256 = await hashRaw(raw);
    const byteLength = new Encoder().encode(raw).byteLength;
    if (byteLength > runtimeByteLimit) throw fail('단일 실행 백업이 16 MiB를 초과하여 이전 백업을 보존하고 중단합니다.', 'RUNTIME_TOO_LARGE');
    const staged = { sha256: sha256, raw: raw, byteLength: byteLength,
      source: typeof source === 'string' ? source : 'runtime_backup', createdAt: new Date().toISOString() };
    await runtimeTransaction(['staging'], 'readwrite', (tx, done, abort) => {
      const store = tx.objectStore('staging'), request = store.get(sha256);
      request.onsuccess = () => {
        if (request.result && request.result.raw !== raw) { abort(fail('실행 백업 보관 원문 충돌', 'VERIFY_FAILED')); return; }
        if (!request.result) store.add(staged);
        done(true);
      };
    });
    const readback = await runtimeRead('staging', sha256) || await runtimeRead('snapshots', sha256);
    if (!readback || readback.raw !== raw || await hashRaw(readback.raw) !== sha256) {
      throw fail('실행 백업 재읽기 검증 실패. 기존 실행 백업은 보존됩니다.', 'VERIFY_FAILED');
    }
    // Promotion, monotonic sequence allocation and pruning are ONE transaction.
    return runtimeTransaction(['snapshots', 'staging', 'meta'], 'readwrite', (tx, done, abort) => {
      const snapshots = tx.objectStore('snapshots'), meta = tx.objectStore('meta');
      const request = snapshots.getAll();
      request.onsuccess = () => {
        const rows = request.result || [];
        if (rows.some(row => !Number.isSafeInteger(row.sequence) || row.sequence < 1 ||
          !Number.isSafeInteger(row.byteLength) || row.byteLength < 0 || typeof row.raw !== 'string' ||
          row.verified !== true || new Encoder().encode(row.raw).byteLength !== row.byteLength)) {
          abort(fail('기존 실행 백업 정보가 손상되어 정리하지 않습니다.', 'RUNTIME_METADATA_INVALID')); return;
        }
        const existing = rows.find(row => row.sha256 === sha256);
        if (existing && existing.raw !== raw) { abort(fail('기존 실행 백업 원문 불일치', 'VERIFY_FAILED')); return; }
        const seqRequest = meta.get('sequence');
        seqRequest.onsuccess = () => {
          const previous = seqRequest.result ? seqRequest.result.value : 0;
          if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER ||
            rows.some(row => row.sequence > previous)) {
            abort(fail('실행 백업 순번이 일치하지 않아 정리하지 않습니다.', 'RUNTIME_SEQUENCE_INVALID')); return;
          }
          const sequence = previous + 1;
          const record = Object.assign({}, staged, { sequence: sequence, verified: true });
          const retained = rows.filter(row => row.sha256 !== sha256).concat([record]).sort((a, b) => b.sequence - a.sequence);
          let bytes = 0, count = 0, pruned = 0, full = false;
          const remove = [];
          for (const row of retained) {
            if (!full && count < runtimeLimit && bytes + row.byteLength <= runtimeByteLimit) { count++; bytes += row.byteLength; }
            else { full = true; remove.push(row.sha256); pruned++; }
          }
          snapshots.put(record);
          meta.put({ key: 'sequence', value: sequence });
          remove.forEach(key => snapshots.delete(key));
          // Staging cleanup does not affect the immutable legacy archive database.
          tx.objectStore('staging').delete(sha256);
          done({ sha256: sha256, verified: true, sequence: sequence, deduplicated: !!existing,
            retainedCount: count, retainedBytes: bytes, prunedCount: pruned, databaseName: runtimeDbName });
        };
      };
    });
  }
  async function exportRuntimeRaw(sha256) {
    if (!/^[a-f0-9]{64}$/.test(String(sha256 || ''))) throw fail('유효한 실행 백업 SHA-256이 필요합니다.', 'INVALID_KEY');
    const record = await runtimeRead('snapshots', sha256);
    if (!record) throw fail('실행 백업이 없거나 보존 범위 밖입니다.', 'ARCHIVE_MISSING');
    if (record.sha256 !== sha256 || typeof record.raw !== 'string' || await hashRaw(record.raw) !== sha256) {
      throw fail('실행 백업 내보내기 검증 실패', 'VERIFY_FAILED');
    }
    return record.raw;
  }
  async function close() {
    const pending = opening;
    opening = null;
    if (pending) (await pending).close();
    const runtimePending = runtimeOpening;
    runtimeOpening = null;
    if (runtimePending) (await runtimePending).close();
  }
  return Object.freeze({
    archiveLegacy: archiveLegacy,
    archiveRaw: archiveRaw,
    exportRaw: exportRaw,
    restoreValue: exportRaw,
    hashRaw: hashRaw,
    previewLegacyCompaction: previewLegacyCompaction,
    commitLegacyCompaction: commitLegacyCompaction,
    archiveRuntimeRaw: archiveRuntimeRaw,
    exportRuntimeRaw: exportRuntimeRaw,
    close: close,
    databaseName: dbName,
    legacyKey: legacyKey
  });
});

(function () {
  'use strict';
  window.bareunInstallRuntimeBackups = function () {
  if (typeof backupState !== 'function') return;
  var archive = null, initializationError = null;
  try { archive = typeof createBareunBackupArchive === 'function' ? createBareunBackupArchive() : null; }
  catch (error) { initializationError = error; }
  var pending = new Set(), state = { pending: 0, verified: 0, failures: 0, lastError: '' }, warned = false;
  function fail(error) {
    state.failures += 1;
    state.lastError = String(error && error.message || error || 'backup_unavailable');
    if (!warned && typeof toast === 'function') {
      warned = true;
      toast('복구용 백업 저장을 확인하지 못했습니다. 현재 화면을 유지해 주세요.', false);
    }
    return { verified: false, error: state.lastError };
  }
  backupState = function (reason, source) {
    var raw;
    try {
      var value = source || (typeof S !== 'undefined' ? S : null);
      if (!value || !value.plan) return Promise.resolve({ skipped: true });
      raw = JSON.stringify(value);
    } catch (error) { return Promise.resolve(fail(error)); }
    if (!archive || typeof archive.archiveRuntimeRaw !== 'function') return Promise.resolve(fail(new Error('runtime_backup_unavailable')));
    state.pending += 1;
    var job = Promise.resolve().then(function () {
      return archive.archiveRuntimeRaw(raw, String(reason || 'backup'));
    }).then(function (result) {
      if (!result || result.verified !== true) throw new Error('runtime_backup_unverified');
      state.verified += 1;
      return result;
    }).catch(fail).finally(function () { state.pending -= 1; pending.delete(job); });
    pending.add(job);
    return job;
  };
  window.bareunRuntimeBackupStatus = function () { return Object.assign({}, state); };
  window.bareunWaitForRuntimeBackups = function () { return Promise.all(Array.from(pending)); };
  if (initializationError) fail(initializationError);
  return true;
  };
})();

'use strict';
/* LockService.getScriptLock() の代替: プロセス内の非同期ミューテックス（FIFO・タイムアウト付き）。
   複数インスタンス間の整合は storage 側の世代番号（GCS generation）で担保する。 */
function createMutex(){
  var queue = [];
  var locked = false;
  function release(){
    var next = queue.shift();
    if (next){ next(); } else { locked = false; }
  }
  function acquire(timeoutMs){
    return new Promise(function(resolve, reject){
      if (!locked){ locked = true; return resolve(release); }
      var timer = null;
      var grant = function(){ if (timer) clearTimeout(timer); resolve(release); };
      queue.push(grant);
      if (timeoutMs > 0){
        timer = setTimeout(function(){
          var i = queue.indexOf(grant);
          if (i >= 0) queue.splice(i, 1);
          reject(new Error('ロック取得がタイムアウトしました（' + timeoutMs + 'ms）。他の処理が長時間プロジェクトを更新中です'));
        }, timeoutMs);
      }
    });
  }
  return { acquire: acquire };
}
module.exports = { createMutex: createMutex };

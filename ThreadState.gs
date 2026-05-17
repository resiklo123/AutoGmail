/**
 * Thread settlement repair — mixed RFQ/non-RFQ per-row breakdown + manual thread settle.
 *
 * Expects elsewhere in the Apps Script project:
 *   - getInboxSheet, buildHeaderMap, setThreadStatus, STATUS, HEADERS.GMAIL_THREAD_ID
 *   - getThreadSettlementRfqBreakdown(thread, resikloEmail, isTrueRfq) -> { finalSettled: boolean, ... }
 */

/** @param {Array} rowVals 0-based row array @param {Object} headerMap header name -> 1-based column index */
function rowIsRfqForReminder(rowVals, headerMap) {
  var rfqCol = headerMap['RfqFlag'];
  if (rfqCol != null) {
    var rfq = String(rowVals[rfqCol - 1] || '').trim().toUpperCase();
    if (rfq === 'TRUE' || rfq === 'YES' || rfq === '1') return true;
  }
  var intentCol = headerMap['Intent'];
  if (intentCol != null) {
    var intent = String(rowVals[intentCol - 1] || '').trim().toUpperCase();
    if (intent === 'RFQ' || intent === 'QUOTE_REQUEST') return true;
  }
  return false;
}

/** 1-based Gmail thread id column; prefers HEADERS.GMAIL_THREAD_ID when provided. */
function gmailThreadColumnIndex_(headerMap) {
  if (typeof HEADERS !== 'undefined' && HEADERS.GMAIL_THREAD_ID != null) {
    var g = HEADERS.GMAIL_THREAD_ID;
    if (typeof g === 'number') return g;
    var byName = headerMap[g];
    if (byName != null) return byName;
  }
  return headerMap['GmailThreadId'] || headerMap['Gmail Thread ID'];
}

function resikloEmailForSettlement_() {
  if (typeof getResikloInboxEmail === 'function') return getResikloInboxEmail();
  if (typeof getResikloEmail === 'function') return getResikloEmail();
  if (typeof RESIKLO_INBOX_EMAIL !== 'undefined') return RESIKLO_INBOX_EMAIL;
  return '';
}

/** Load Gmail thread once per thread id for repair (not used by repairThreadSelectedRow). */
function loadGmailThreadForRepair_(threadId) {
  if (typeof loadGmailThread === 'function') return loadGmailThread(threadId);
  if (typeof GmailApp !== 'undefined' && GmailApp.getThreadById) {
    try {
      return GmailApp.getThreadById(threadId);
    } catch (e) {
      return null;
    }
  }
  return null;
}

/** @param {Array} rowVals @param {Object} headerMap */
function isRowAlreadySettled_(rowVals, headerMap) {
  var statusCol = headerMap['ThreadStatus'] || headerMap['Status'] || headerMap['Settlement'];
  if (statusCol == null) return false;
  var st = String(rowVals[statusCol - 1] || '').trim().toUpperCase();
  if (st === 'SETTLED') return true;
  var settledLabel = typeof STATUS !== 'undefined' && STATUS && STATUS.SETTLED ? String(STATUS.SETTLED).toUpperCase() : 'SETTLED';
  return st === settledLabel;
}

/**
 * True if any non-SETTLED row in the thread group is settled per Gmail when using that row's
 * RFQ mode (via getThreadSettlementRfqBreakdown). No grouped RFQ boolean.
 *
 * @param {string} logPrefix e.g. '[repairThreadsLast200]'
 */
function repairThreadGroupHasUnsettledRowSettledInGmail(sheet, headerMap, threadId, threadRowNums, threadRowsValues, logPrefix) {
  if (typeof getThreadSettlementRfqBreakdown !== 'function') {
    Logger.log((logPrefix || '[repair]') + ' getThreadSettlementRfqBreakdown is not defined');
    return false;
  }
  var resikloEmail = resikloEmailForSettlement_();
  var thread = loadGmailThreadForRepair_(threadId);
  var shouldSettleThread = false;
  for (var i = 0; i < threadRowsValues.length; i++) {
    var rowVals = threadRowsValues[i];
    var rowNum = threadRowNums[i];
    if (isRowAlreadySettled_(rowVals, headerMap)) continue;

    var isTrueRfq = rowIsRfqForReminder(rowVals, headerMap);
    var breakdown = getThreadSettlementRfqBreakdown(thread, resikloEmail, isTrueRfq);
    var finalOk = !!(breakdown && breakdown.finalSettled === true);
    Logger.log(
      (logPrefix || '[repair]') +
        ' row=' +
        rowNum +
        ' threadId=' +
        threadId +
        ' isTrueRfq=' +
        isTrueRfq +
        ' finalSettled=' +
        finalOk
    );
    if (finalOk) {
      shouldSettleThread = true;
    }
  }
  return shouldSettleThread;
}

/**
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} headerMap
 * @param {Array<Array>} values including header row [0]
 * @param {number} firstDataRow 1-based
 * @param {number} lastDataRowInclusive 1-based
 * @param {string} logPrefix
 */
function repairThreadStatusesInRowRange_(sheet, headerMap, values, firstDataRow, lastDataRowInclusive, logPrefix) {
  var threadCol = gmailThreadColumnIndex_(headerMap);
  if (threadCol == null) {
    Logger.log('repairThreadStatusesInRowRange_: Gmail thread id column missing');
    return;
  }
  var groups = {};
  for (var r = firstDataRow; r <= lastDataRowInclusive; r++) {
    var rowIdx = r - 1;
    if (rowIdx < 1 || rowIdx >= values.length) continue;
    var rowVals = values[rowIdx];
    var tid = String(rowVals[threadCol - 1] || '').trim();
    if (!tid) continue;
    if (!groups[tid]) groups[tid] = { nums: [], rows: [] };
    groups[tid].nums.push(r);
    groups[tid].rows.push(rowVals);
  }
  for (var threadId in groups) {
    if (!Object.prototype.hasOwnProperty.call(groups, threadId)) continue;
    var g = groups[threadId];
    var shouldSettleThread = repairThreadGroupHasUnsettledRowSettledInGmail(
      sheet,
      headerMap,
      threadId,
      g.nums,
      g.rows,
      logPrefix
    );
    if (shouldSettleThread) {
      var settledStatus = typeof STATUS !== 'undefined' && STATUS && STATUS.SETTLED ? STATUS.SETTLED : 'SETTLED';
      setThreadStatus(sheet, headerMap, threadId, settledStatus);
    }
  }
}

/** Recent rows: last N data rows of Inbox. */
function repairThreadStatusesRecent() {
  var sheet = typeof getInboxSheet === 'function' ? getInboxSheet() : SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Inbox');
  var headerMap = typeof buildHeaderMap === 'function' ? buildHeaderMap(sheet) : buildHeaderMapFromSheet_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var recentCount = typeof REPAIR_RECENT_ROW_COUNT === 'number' ? REPAIR_RECENT_ROW_COUNT : 200;
  var first = Math.max(2, lastRow - recentCount + 1);
  var values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  repairThreadStatusesInRowRange_(sheet, headerMap, values, first, lastRow, '[repairThreadStatusesRecent]');
}

/** Last 200 data rows — same per-row breakdown; only setThreadStatus when shouldSettleThread. */
function repairThreadsLast200() {
  var sheet = typeof getInboxSheet === 'function' ? getInboxSheet() : SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Inbox');
  var headerMap = typeof buildHeaderMap === 'function' ? buildHeaderMap(sheet) : buildHeaderMapFromSheet_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var first = Math.max(2, lastRow - 199);
  var values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  repairThreadStatusesInRowRange_(sheet, headerMap, values, first, lastRow, '[repairThreadsLast200]');
}

/** @param {GoogleAppsScript.Spreadsheet.Sheet} sheet */
function buildHeaderMapFromSheet_(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  for (var c = 0; c < headers.length; c++) {
    var h = String(headers[c] || '').trim();
    if (h) map[h] = c + 1;
  }
  return map;
}

function countInboxRowsForThread_(sheet, threadCol, threadId) {
  var n = 0;
  var lr = sheet.getLastRow();
  for (var r = 2; r <= lr; r++) {
    if (String(sheet.getRange(r, threadCol).getValue() || '').trim() === threadId) n++;
  }
  return n;
}

/**
 * Manual fallback: settle entire thread by GmailThreadId. No Gmail settlement helpers.
 */
function repairThreadSelectedRow() {
  var sheet = typeof getInboxSheet === 'function' ? getInboxSheet() : SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Inbox');
  var headerMap = typeof buildHeaderMap === 'function' ? buildHeaderMap(sheet) : buildHeaderMapFromSheet_(sheet);
  var threadCol = gmailThreadColumnIndex_(headerMap);
  if (threadCol == null) {
    SpreadsheetApp.getUi().alert('Gmail thread id column missing (HEADERS.GMAIL_THREAD_ID / header map).');
    return;
  }
  var active = sheet.getActiveRange();
  if (!active) {
    SpreadsheetApp.getUi().alert('Select a row in Inbox.');
    return;
  }
  var row = active.getRow();
  if (row < 2) {
    SpreadsheetApp.getUi().alert('Select a data row (not header).');
    return;
  }
  var threadId = String(sheet.getRange(row, threadCol).getValue() || '').trim();
  if (!threadId) {
    SpreadsheetApp.getUi().alert('Selected row has no GmailThreadId.');
    return;
  }
  var rowsUpdated = countInboxRowsForThread_(sheet, threadCol, threadId);
  var settledStatus = typeof STATUS !== 'undefined' && STATUS && STATUS.SETTLED ? STATUS.SETTLED : 'SETTLED';
  setThreadStatus(sheet, headerMap, threadId, settledStatus);
  Logger.log('[repairThreadSelectedRow] threadId=' + threadId + ' rowsUpdated=' + rowsUpdated);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss && typeof ss.toast === 'function') {
    ss.toast('Settled ' + rowsUpdated + ' row(s) for thread', 'Repair Thread', 5);
  }
}

/**
 * Read-only: logs + dialog only.
 */
function debugSettlementForSelectedRow() {
  var sheet = typeof getInboxSheet === 'function' ? getInboxSheet() : SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Inbox');
  var headerMap = typeof buildHeaderMap === 'function' ? buildHeaderMap(sheet) : buildHeaderMapFromSheet_(sheet);
  var threadCol = gmailThreadColumnIndex_(headerMap);
  var active = sheet.getActiveRange();
  var row = active ? active.getRow() : 0;
  if (!active || row < 2 || !threadCol) {
    Logger.log('debugSettlementForSelectedRow: invalid selection or map');
    return;
  }
  var lastCol = sheet.getLastColumn();
  var rowVals = sheet.getRange(row, 1, row, lastCol).getValues()[0];
  var threadId = String(rowVals[threadCol - 1] || '').trim();
  var isTrueRfq = rowIsRfqForReminder(rowVals, headerMap);
  var msgParts = ['row=' + row, 'GmailThreadId=' + threadId, 'rowIsRfqForReminder=' + isTrueRfq];
  if (typeof getThreadSettlementRfqBreakdown === 'function') {
    var thread = loadGmailThreadForRepair_(threadId);
    var resikloEmail = resikloEmailForSettlement_();
    var breakdown = getThreadSettlementRfqBreakdown(thread, resikloEmail, isTrueRfq);
    msgParts.push('finalSettled=' + (breakdown && breakdown.finalSettled));
  } else {
    msgParts.push('getThreadSettlementRfqBreakdown not defined');
  }
  var msg = msgParts.join('\n');
  Logger.log('[debugSettlementForSelectedRow]\n' + msg);
  SpreadsheetApp.getUi().alert('Settlement debug (read-only)', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

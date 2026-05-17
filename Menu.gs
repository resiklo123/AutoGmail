/**
 * Add to your existing `onOpen` menu (Apps Script allows only one `onOpen` per project):
 *
 *   contentopsRegisterRepairMenuItems_(menu);
 *
 * Or call `contentopsRegisterRepairMenuItems_` when building your custom menu.
 */

function contentopsRegisterRepairMenuItems_(menu) {
  return menu
    .addSeparator()
    .addItem('Repair Thread (Selected Row)', 'repairThreadSelectedRow')
    .addItem('Debug settlement (selected row, read-only)', 'debugSettlementForSelectedRow');
}

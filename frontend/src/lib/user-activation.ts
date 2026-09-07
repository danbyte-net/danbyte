/** True when the currently-running event plausibly comes from a real user
 * gesture (click/keypress within the browser's transient-activation window).
 *
 * Browser and form-filler-extension autofill dispatch change events on page
 * load with no activation behind them. A Radix Select inside a `<form>`
 * mirrors itself into a hidden native `<select>` for exactly that autofill
 * machinery and forwards its change events into `onValueChange` - so a
 * save-on-change control would persist whatever row the filler picked. On the
 * site form that silently cleared the saved engine/SNMP bindings on every
 * reload (#125). Browsers without `navigator.userActivation` (and jsdom)
 * report true, i.e. behave as before.
 */
export function isUserInitiated(): boolean {
  // lib.dom types this always-present; older browsers actually lack it.
  const ua = (navigator as Partial<Navigator>).userActivation
  return ua ? ua.isActive : true
}

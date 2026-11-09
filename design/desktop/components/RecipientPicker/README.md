# Recipient picker

Who hears about something, as To / Cc / Bcc pill boxes, and — where it is an email — which
email channels it goes out on.

One implementation, `public/js/recipient-picker.js` (`PolarisRecipientPicker`): the automations
wizard's Notify and Reboot actions bind it to their catalogues, and the firmware-upgrade and
reboot dialogs use its `notifyEditor`, which adds the **Send through** channel list.

- A pill is a user, an address, a role, a region, a tag, or a dynamic entry ("Asset’s L1
  Region Users", "Asset’s Responsible Contacts") that is worked out from the device when the
  email is sent. The qualifier ahead of the label (`role:`, `region:`, `dynamic:`) keeps a
  region called "Ashfield" from reading as a person.
- Dynamic entries are To-only; Cc and Bcc are fixed lists.
- Typing two characters offers roles, regions, tags and dynamic entries at once, then the
  address book's people. Enter or a comma commits a typed address; Backspace in an empty box
  removes the last pill. Pills drag between the three boxes.
- **Address book** opens the address-book picker stacked over the dialog. `+` on a typed
  address saves it to the book.
- **Send through** lists the enabled SMTP and Microsoft 365 channels only — never push,
  Pushbullet, Teams or Slack. The oldest is ticked when nothing was chosen.

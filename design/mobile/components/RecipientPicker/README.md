# Recipient picker

To / Cc / Bcc pill boxes for the firmware-upgrade and reboot sheets' **Email notifications**,
with the email channels the notifications go out on.

The same control as the desktop's (`public/js/recipient-picker.js`, its `notifyEditor`), in
the phone's tokens (`mobile.css` → Recipient picker). Each box is outlined like a text field;
pills are `md-secondary-container` with a 28px remove target.

- Typing two characters offers roles, regions, tags, the device's dynamic recipients, and
  the address book's people in a list under the box. Enter or a comma commits a typed address.
- There is no Address book button on the phone: the address-book picker is a desktop dialog,
  and typing reaches the same people.
- Dynamic entries ("Asset’s L1 Region Users") are To-only; Cc and Bcc are fixed lists.
- The channel list holds the enabled SMTP and Microsoft 365 channels only.

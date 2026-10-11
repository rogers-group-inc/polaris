# File map — tests/

Unit + integration suites.

A slice of the repository tree (`polaris/` is the root; `│` continuation bars are relative to it). Per-file purpose notes follow each entry.
```
└── tests/
    ├── unit/
    │   ├── cidr.test.ts
    │   ├── ipService.test.ts
    │   ├── primaryAddressPin.test.ts      # applyPrimaryAddressPin (reassert / follow / none) + assetAddressService pure helpers (business rule 102)
    │   ├── assetAddressesDom.test.ts      # General-tab Primary Address + Addresses rows (per-MAC groups matched case/separator-blind, "Not on MAC list" groups with no ×, Set as primary, port-MAC collapse, +N MACs overflow) Also pins the rule 103 address-confidence chips (banded chip + hover breakdown in the panel, plain titled chips in the list cell).
    │   ├── ipamAddressVerdict.test.ts     # judgeDhcpAddressAgainstIpam — keep / remove / relabel a DHCP address row against IPAM (business rule 102(a))
    │   ├── addressConfidence.test.ts      # utils/addressConfidence: EVIDENCE_KINDS decay, scoreAddress (strongest per kind, penalties, bands, score vs evidenceScore), pollingWeight, pollingRunStart / pollingHoursFor (business rule 103)
    │   └── subnetService.test.ts
    └── integration/
        ├── blocks.test.ts
        ├── primaryAddress.test.ts         # PUT/DELETE /assets/:id/primary-address, db.ts guard, MAC remove, discovered-address reconcile + per-gate prune (business rule 102)
        ├── addressConfidence.test.ts      # buildAddressConfidence evidence gather + penalties, GET /assets(/:id) addressConfidence, POST /assets/:id/address-check (business rule 103)
        ├── assetIpamAddressCheck.test.ts  # GET /assets/:id re-checks DHCP address rows against IPAM: released / other-MAC dropped, relabel, per-gate scope, read grant (business rule 102(a))
        ├── subnets.test.ts
        └── reservations.test.ts
```

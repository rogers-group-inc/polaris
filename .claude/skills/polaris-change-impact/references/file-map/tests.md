# File map — tests/

Unit + integration suites.

A slice of the repository tree (`polaris/` is the root; `│` continuation bars are relative to it). Per-file purpose notes follow each entry.
```
└── tests/
    ├── unit/
    │   ├── cidr.test.ts
    │   ├── ipService.test.ts
    │   ├── primaryAddressPin.test.ts      # applyPrimaryAddressPin (reassert / follow / none) + assetAddressService pure helpers (business rule 102)
    │   ├── assetAddressesDom.test.ts      # General-tab Primary Address + Addresses rows (per-MAC groups, Set as primary, port-MAC collapse, +N MACs overflow)
    │   └── subnetService.test.ts
    └── integration/
        ├── blocks.test.ts
        ├── primaryAddress.test.ts         # PUT/DELETE /assets/:id/primary-address, db.ts guard, MAC remove, discovered-address reconcile + per-gate prune (business rule 102)
        ├── subnets.test.ts
        └── reservations.test.ts
```

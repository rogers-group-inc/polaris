# File map — tests/

Unit + integration suites.

A slice of the repository tree (`polaris/` is the root; `│` continuation bars are relative to it). Per-file purpose notes follow each entry.
```
└── tests/
    ├── unit/
    │   ├── cidr.test.ts
    │   ├── ipService.test.ts
    │   ├── primaryAddressPin.test.ts      # applyPrimaryAddressPin (reassert / follow / none, and the primaryAddressContestedAt stamp: set on a different staged address, not on a follow or a staged clear) + assetAddressService pure helpers (business rule 102)
    │   ├── assetAddressesDom.test.ts      # General-tab Address row (primary IP only, label "Address") + its pills (addressPillsHTML: N IPs hover primary-first and starred with copyable IP + MAC and Set as primary; N MACs hover with per-card IPs matched case/separator-blind, first three named, "Not on MAC list" with no ×, remove ×; port-MAC pill; MAC pill still drawn with no IP). Also pins the rule 103 address-confidence chips (banded chip + hover breakdown on the Address row, plain titled chips in the IPs hover and the list cell).
    │   ├── ipamAddressVerdict.test.ts     # judgeDhcpAddressAgainstIpam — keep / remove / relabel a DHCP address row against IPAM (business rule 102(a))
    │   ├── assetPanelClickWiring.test.ts  # public/js/assets.js wires the asset-panel click handlers (_handleMacDeleteClick, _handlePrimaryAddressClick) once at LOAD behind window.__polarisMacDeleteWired / __polarisPrimaryAddressWired, not in the Assets page init — the panel opens on any page via global search
    │   ├── addressConfidence.test.ts      # utils/addressConfidence: EVIDENCE_KINDS decay, scoreAddress (strongest per kind, penalties, bands, score vs evidenceScore), sustained freshness (polling answering → score / evidenceScore not aged, discoveryScore still decays), the detected-ambiguous kind, pollingWeight, pollingRunStart / pollingHoursFor (business rule 103)
    │   └── subnetService.test.ts
    └── integration/
        ├── blocks.test.ts
        ├── primaryAddress.test.ts         # PUT/DELETE /assets/:id/primary-address, db.ts guard, MAC remove, discovered-address reconcile + per-gate prune (business rule 102)
        ├── addressConfidence.test.ts      # buildAddressConfidence evidence gather + penalties, GET /assets(/:id) addressConfidence, POST /assets/:id/address-check, the 103(a) pin-release sweep (a contested pin is skipped); ARP-table evidence (an arp piece for any address a gate binds the asset's MAC to, the arp-elsewhere penalty, detected-ambiguous for a card ARP shows with several addresses); "infra and history evidence": a FortiAP scored from its controller record's mgmtIp, seedPollingRuns from probe history, unpin moving to the best LISTED address (business rule 103(b))
        ├── assetIpamAddressCheck.test.ts  # GET /assets/:id re-checks DHCP address rows against IPAM: released / other-MAC dropped, relabel, per-gate scope, read grant (business rule 102(a))
        ├── subnets.test.ts
        └── reservations.test.ts
```

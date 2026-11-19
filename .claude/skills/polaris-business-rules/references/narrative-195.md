# Business rule 195 — full narrative

<a id="rule-195"></a>

## Rule 195 — The host's own agent decides its primary address when it can prove it

**The incident (2026-11-19, prod).** A plant HMI again — a Windows 11 mini-PC with an Ethernet card and a Wi-Fi card, the same shape as rule 101's. Its Polaris agent reported `primaryIp` 172.22.175.193 on the Ethernet card (MAC E0:51:…, the asset's primary MAC). The asset's address was 172.22.174.134, the Wi-Fi card's lease (MAC 44:90:…) that the FortiGate held. The owner's question: "polaris agent should win here, no?" — then, narrowed: "win the primary ip".

**Why it didn't.** The agent had no vote on the address at all. `IP_ADDRESS_RULES` ranked Fortinet management IPs, vCenter, the workload platforms, Arc, the `fortigate-endpoint` sighting and Generic API; the agent's blob carried `primaryIp` and nothing read it. Rule 103(e) made the agent evidence for the confidence SCORE, and rule 103 says the score only informs. Rule 101's ladder ranks only what gates report, and the gate held no binding for the Ethernet card (a static address, or a DHCP server that is not the gate), so wired-over-wireless never had a wired claim to prefer.

**Why the raw `primaryIp` is not the answer.** The agent picks it as the first up, non-loopback interface with an IPv4, in the order the OS enumerates them. On Windows that is regularly a Hyper-V / WSL vEthernet, a FortiClient tunnel or a Docker adapter. Ranking it on top would trade this bug for a worse one, on every host with a virtual switch.

**Decision: the connect-from address, cross-checked.** The address the agent connects to Polaris from is the interface the host's routing table chose to reach the server. It counts only when it is RFC 1918 IPv4 (loopback is an unresolved proxy hop; a public address is a NAT gateway's) and is one the agent itself reports — its `agent-interface` rows or its `primaryIp`. An address the host does not have means a translation in between, and the translated address belongs to some other device. The same two conditions rule 103(e)'s `agentSourceCounts` uses, made stricter in one way: 103(e) accepts an agent that has not reported interfaces yet; here the address must be reported somewhere, because this decides rather than informs. The owner chose this over the raw `primaryIp` when offered both.

**Where it ranks.** Below the Fortinet management IPs (a managed device is monitored on its management address, and no agent runs on one). Above vCenter's guest IP (Tools reports the first guest IP, the same enumeration problem), the workload platforms, Arc's network profile, the gate sighting and Generic API. Pins — the typed override, the blank pin, the primary-address pin — still win, through the `src/db.ts` guard and by the push never writing a pinned asset.

**Why the ladder had to be told.** Adding the rule to the projection alone would have made the address flap: rule 101's Phase 6 / 7 / 7.5 stage `ipAddress` for every endpoint with no knowledge of higher sources, and the endpoint flush at the end of the same run re-projects. Each FortiManager run would have moved the HMI to the Wi-Fi lease and back, writing IP history and probing the wrong address in between. The ladder now reads, once per run, which assets their agent holds (`DhcpClaimState.agentHeldAddress`), and for those it still ranks claims, records sightings, MAC rows and address-list rows, but stages no address. The integration test proves the flap by its absence: a final-state assertion passes even without the guard, so it asserts that no `AssetIpHistory` row carries the gate as its source.

**Applied on the push.** The agent's system-info push re-projected hostname, OS and serial but never the address, so the rule would otherwise wait for the next discovery run. The push now writes the address when the agent's answer won and differs, and audits the move.

**How long it holds.** 24 hours after the agent's last push (the agent-interface evidence window of 103(e)). The heartbeat interval is operator-configurable and uncapped, so a short window could drop the claim between pushes on a slow agent. A host that moves gets a new confirmed address on its next push regardless; the window only bounds how long a dead agent holds an address before rule 101 decides again. A push that cannot confirm (behind NAT now, or the address left the host's report) drops `confirmedIp` from the blob at once.

**Deployment shapes.** The caller address is `req.ip`. Behind nginx or a load balancer with `trust proxy` set it is the agent's address from `X-Forwarded-For`. A direct install with no proxy trust sees the real peer. An install behind a proxy WITHOUT `trust proxy` sees loopback and confirms nothing — the feature degrades to rule 101, which is the behaviour before it. A host whose agent reaches Polaris over a VPN is held on the tunnel address: that is the address the host is reachable on from Polaris.

**Rejected.**
- *The raw `primaryIp` wins.* The virtual-adapter case above.
- *Make the score decide.* Rule 103 keeps the score informational; this rule gives one specific, provable source a rank instead.
- *Count `confirmedIp` in the confidence score.* It is the agent-source address checked against the agent-interface rows, both already scored by 103(e); listing it would count the same evidence twice.
- *Guard the ladder for every higher source (vCenter, Arc).* Those can flap the same way, but nobody has reported it and widening it changes behaviour for every VM; left as a known open question rather than folded in unasked.

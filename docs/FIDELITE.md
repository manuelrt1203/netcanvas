# Fidélité du simulateur et limites

NetCanvas calcule l'**état convergé** du réseau (pas de temps réel entre les messages de contrôle) et reproduit le comportement et l'affichage de Cisco IOS 12.4 / 15.

## Vérifié contre du vrai IOS

Les quatre TP BGP du cours (prise en main, Weight, Local Preference, MED) ont été exécutés sur du vrai IOS (Dynamips, c3640 12.4(16), GNS3 2.2) puis comparés à NetCanvas. Identiques : chemins préférés, attributs (LocPrf, Metric, Weight, AS_PATH), marquage `r` (RIB-failure), routes `B [20/0]`, `B [200/0]`, `D EX [170/…]` avec les mêmes métriques EIGRP, effet du `weight`, de la `local-preference` et du MED (R5 passe de `[170/284160] via 10.0.45.4` à `[170/286720] via 10.0.57.7`).

Écarts connus et assumés :
- **Redistribution mutuelle sans étiquette** (IGP vers BGP puis BGP vers IGP, sans `route-map` + `tag`) : sur du vrai matériel les tables oscillent en permanence (compteur « BGP table version » qui s'emballe). NetCanvas ne ré-injecte pas dans BGP une route que l'IGP a reçue de BGP et affiche donc l'état sain, celui des captures d'un TP réussi.
- **Ordre des chemins** : IOS les liste dans l'ordre d'arrivée, NetCanvas met le meilleur en premier.
- **Âge des chemins** (départage de deux chemins eBGP égaux) : NetCanvas prend le plus petit router-id, IOS prend le plus ancien.
- Les durées affichées (uptime, `Up/Down`) sont fixes.

## Protocoles simulés
VLAN, trunk, VTP, STP (PVST+), EtherChannel, port-security · routage statique, OSPF, RIP, EIGRP, BGP (eBGP, iBGP, `next-hop-self`, `update-source`, `weight`, local-pref, MED, AS_PATH, `route-map` en entrée et en sortie, `prefix-list`, ACL de correspondance, `set as-path prepend`) · redistribution (avec `route-map` : `match tag`, `set tag`) · NAT/PAT, DHCP, DNS, web, ACL · IPv6 (SLAAC, OSPFv3, ACL, DHCPv6).

Commandes d'affichage : `show ip bgp [préfixe]`, `show ip bgp summary`, `show ip bgp neighbors`, `show ip route [adresse]`, `show route-map`, `show ip prefix-list`, `show running-config`, avec les filtres `| include | exclude | begin | section`.

## Non simulé (annoncé par le terminal quand on le tape)
- Résumé automatique (`auto-summary`), `ip summary-address`, communautés BGP, `filter-list` / `as-path access-list`, réflecteurs de routes, confédérations, agrégation BGP, dampening.
- Timers (MRAI, hold), reconvergence progressive : un `clear ip bgp *` est sans effet, le résultat est déjà recalculé.
- VRF, MPLS (les TP « VRF » et « MPLS VPN » ne sont pas couverts).
- Captures de paquets : le mode **pas à pas** montre les trames du simulateur, pas une capture réelle.

# NetCanvas

Éditeur de schémas réseau **vivants** : les équipements ont une vraie configuration (IP, masque, passerelle, VLAN, routes statiques), et un simulateur montre le chemin d'un ping, ou explique pourquoi il échoue.

## Lancer

```bash
npm install
npm run dev        # http://localhost:5173
```

Menu **Démos** :
- **2 VLAN, 2 routeurs** : routage statique, liaison série /30 entre R1 et R2 ;
- **Router-on-a-stick** : un trunk 802.1Q entre le switch et R1, une sous-interface par VLAN ;
- **Switch niveau 3** : un 3560 route 3 VLAN par ses interfaces VLAN (SVI) et sort vers Internet par R1 ;
- **NAT / PAT** : une box en PAT, un serveur web local publié en NAT statique, un FAI qui ne connaît aucune adresse privée ;
- **DHCP** : R1 distribue le VLAN 10, le VLAN 20 obtient ses adresses d'un serveur du VLAN 30 par relais (`ip helper-address`) ;
- **OSPF 2 zones** : R1 en zone 1, R2 en ABR, un MikroTik en zone 0 qui annonce la route par défaut vers Internet ;
- **BGP eBGP + iBGP** : AS 65001 (iBGP entre loopbacks, OSPF comme IGP) et un MikroTik dans l'AS 65002.

## Fonctions

- **Matériel réel** : modèles Cisco avec leurs vrais ports, modules d'extension, 6 types de câbles (détails plus bas). Glisser-déposer ou clic (alternative clavier).
- **Câblage contrôlé** : voyants vert / rouge sur chaque câble, et une explication quand il ne fonctionne pas (câble droit entre deux PC, fibre sur un port cuivre, clock rate absent…). Étiquette `VLAN 10` / `Trunk` sur les liens.
- **Routage dynamique** : OSPF (multi-zones), RIP v2, BGP (eBGP et iBGP), loopbacks, avec des explications quand une adjacence ou une session ne monte pas (détails plus bas).
- **Formulaire ou terminal, au choix** : terminal Cisco IOS, MikroTik RouterOS ou invite de commandes du PC. Les deux modes modifient la même configuration (détails plus bas).
- **Configuration** :
  - PC / serveur / Internet : IP, masque CIDR (on peut taper `192.168.1.10/24`), passerelle ;
  - routeur : une IP par interface, routes statiques (route par défaut `0.0.0.0/0`) ;
  - switch : chaque port en access (VLAN 1-4094) ou en trunk 802.1Q (VLAN natif 1).
- **Contrôles en direct** : IP en double, passerelle hors réseau, adresse de réseau ou de diffusion, interfaces d'un routeur dans le même réseau, saut suivant injoignable, ports de switch incohérents (access ↔ trunk, VLAN différents).
- **Simulation de ping** : animation de l'echo request (bleu) puis de l'echo reply (vert), avec un journal de chaque décision. L'équipement fautif est entouré en rouge.
- **Exports** vers Packet Tracer, GNS3, Containerlab, draw.io, CSV, SVG et PNG (détails plus bas).
- **Édition confortable** : annuler / rétablir (Ctrl+Z, Ctrl+Y, 100 étapes), copier-coller et duplication avec la configuration et les câbles internes (noms renumérotés), sélection multiple (Maj+clic, Maj+glisser) avec alignement et répartition, recherche par nom, modèle ou IP (Ctrl+K), aide des raccourcis (?).
- **Import JSON**, sauvegarde automatique du brouillon, mode sombre, `prefers-reduced-motion` respecté.

## Routage dynamique (`src/net/routing.js`)

NetCanvas calcule la table de routage de chaque routeur à l'**état convergé** (pas de minuteurs ni de paquets hello), puis le ping la suit routeur par routeur.

| Protocole | Ce qui est calculé |
|---|---|
| OSPF | voisins découverts sur le domaine de diffusion (mêmes zone, masque et sous-réseau, pas de `passive-interface`), DR/BDR, SPF de Dijkstra, routes `O` / `O IA` (seulement à travers la zone 0) / `O E2` (`redistribute static|connected`, `default-information originate [always]`) ; coût = 10⁸ / débit (`bandwidth`) ou `ip ospf cost` ; router-id configuré, sinon plus grande loopback |
| RIP v2 | Bellman-Ford, split horizon, 15 sauts maximum, `passive-interface`, `default-information originate`, `redistribute static`, versions incompatibles |
| BGP | sessions vérifiées : adresse et AS du voisin, `update-source`, `ebgp-multihop`, joignabilité par un vrai ping dans les deux sens. Propagation avec AS_PATH (boucle rejetée), pas de relais iBGP → iBGP, next-hop conservé en iBGP (sauf `next-hop-self`) et résolu par l'IGP, `network` seulement si la route exacte est dans la table, `redistribute connected|static|ospf` |
| Choix final | plus long préfixe, puis distance administrative : connecté 0, statique 1, eBGP 20, OSPF 110, RIP 120, iBGP 200 |

Quand ça ne marche pas, NetCanvas dit pourquoi, dans les contrôles, le terminal et le ping. Exemples :
- « OSPF : pas d'adjacence R1 G0/1 ↔ R2 G0/0 : zones différentes (0 et 1). »
- « BGP : session R1 → 2.2.2.2 down : R2 attend R1 sur 1.1.1.1, mais la session part de 10.0.12.1 : ajoute « neighbor 2.2.2.2 update-source Lo0 » sur R1. »
- « BGP : R1 reçoit 172.16.0.0/24 avec le next-hop 10.0.23.2, injoignable : la route n'est pas utilisée (« neighbor … next-hop-self » …). »

On configure le routage dans le **formulaire** (sections OSPF / RIP / BGP, avec l'état des voisins et des sessions) ou dans le **terminal**. Le terminal IOS gère `router ospf|rip|bgp`, `network`, `passive-interface`, `neighbor … remote-as|update-source|next-hop-self|ebgp-multihop`, `ip ospf cost`, `ip ospf <pid> area <n>`, `bandwidth`, `interface loopback`, et les `show ip route [ospf|rip|bgp|static|connected]`, `show ip ospf neighbor`, `show ip ospf interface brief`, `show ip protocols`, `show ip bgp`, `show ip bgp summary`. Le terminal RouterOS v7 gère `/routing ospf instance|area|interface-template|neighbor`, `/routing rip instance|interface-template|neighbor`, `/routing bgp connection|session` et `/ip firewall address-list` (réseaux annoncés en BGP).

Cisco et MikroTik se parlent : adjacence OSPF ou session BGP entre un 2911 et un RB4011.

Pas simulé : EIGRP, OSPF de type NSSA/stub et liens virtuels, résumé de routes, attributs BGP au-delà de l'AS_PATH (local-preference, MED, communautés), route-maps et filtres.

## Terminal (`src/cli/`)

Dans l'onglet Propriétés d'un équipement, le sélecteur **Formulaire / Terminal** change le mode (retenu d'une session à l'autre). Les commandes écrivent la même configuration que le formulaire : on peut passer de l'un à l'autre à tout moment.

| Terminal | Équipements | Commandes |
|---|---|---|
| Cisco IOS | routeurs et switches Cisco | modes `>` `#` `(config)#` `(config-if)#` `(config-if-range)#` `(config-vlan)#` ; `enable`, `configure terminal`, `interface` (et `range`), `ip address`, `shutdown`, `description`, `clock rate`, `ip route`, `hostname`, `vlan` / `name`, `switchport mode` / `access vlan`, `do`, `end`, `write`, `show running-config`, `show ip interface brief`, `show ip route`, `show vlan brief`, `show cdp neighbors`, `show version`, `ping` |
| MikroTik RouterOS | modèles MikroTik | `/ip address add/print/remove`, `/ip route add/print/remove`, `/interface print/enable/disable`, `/system identity set/print`, `/ping`, `/export`, navigation dans les menus (`/ip address`, `..`) |
| Invite de commandes | PC, portable, serveur, imprimante | `ipconfig`, `ipconfig <ip> <masque> [passerelle]`, `ping <ip> [-n N]`, `cls`, `help` |

Comme sur le vrai matériel :
- **Abréviations** : `conf t`, `sh ip int br`, `no sh`, `/ip addr pr`.
- **Aide et saisie** : `?` affiche l'aide sans valider la ligne, Tab complète, ↑ ↓ parcourent l'historique, Ctrl+Z sort de la configuration.
- **Messages d'erreur fidèles** : `% Invalid input detected at '^' marker.` avec le marqueur au bon endroit, `% Incomplete command.`, `% Ambiguous command`, `bad command name`.
- **Refus réalistes** : masque non contigu (`% Bad mask`), adresse de réseau, chevauchement entre deux interfaces, `clock rate` côté DTE, `ip address` sur un port de switch.
- **Messages d'état** : `%LINK-5-CHANGED` et `%LINEPROTO-5-UPDOWN` après `shutdown` / `no shutdown`.
- **Config attachée au port** : elle reste sur le port quand on débranche le câble, et on peut configurer un port avant de le câbler.

La particularité de NetCanvas reste là : un `ping` tapé dans un terminal s'anime sur le plan, et en cas d'échec une ligne `% NetCanvas :` donne la raison (câble, route, VLAN, boucle…).

**Router-on-a-stick** : sous-interfaces `G0/0.10` + `encapsulation dot1Q 10 [native]` (IOS), `/interface vlan` (RouterOS) ou le formulaire du routeur. La trame part étiquetée sur le trunk ; un VLAN absent ou un port du switch en access est expliqué.

**traceroute** : `traceroute` (IOS), `tracert` (PC), `/tool traceroute` (RouterOS) et le bouton du panneau Simulation. Chaque routeur répond depuis son interface d'entrée, et n'apparaît que si sa réponse revient jusqu'à la source.

**Switch niveau 3** : `interface vlan 10` + `ip address`, `ip routing`, `ip route`, `router ospf` (3560/3650), ou le formulaire du switch. Une SVI est active si un port actif est dans son VLAN. Un 2960 peut avoir une SVI d'administration et un `ip default-gateway`, mais ne route pas, et NetCanvas l'explique (comme l'oubli de `ip routing`).

**ACL** : standard et étendues, numérotées (`access-list 10 …`, `access-list 100 …`) ou nommées (`ip access-list extended NOM`), appliquées par `ip access-group NOM in|out`, avec `show access-lists`. Le ping indique quelle ACL, quelle ligne et quelle interface l'ont bloqué, y compris le refus implicite final. Comme sur IOS, une ACL appliquée mais inexistante laisse tout passer (signalé dans les contrôles), et le trafic émis par le routeur ne passe pas par son ACL de sortie. Côté MikroTik : `/ip firewall filter` (chain=forward / input). Exportées vers Packet Tracer, RouterOS et Containerlab (iptables, vérifié par de vrais pings). Formulaire « ACL et NAT » : règles en syntaxe IOS avec les erreurs ligne par ligne, application par interface.

**NAT / PAT** : `ip nat inside|outside`, `ip nat inside source list N interface X overload` (PAT), `… pool NOM [overload]` + `ip nat pool`, `ip nat inside source static A B`, `show ip nat translations` ; MikroTik : `/ip firewall nat` (masquerade, src-nat, dst-nat). Ordre IOS respecté : ACL d'entrée, NAT de destination, routage, NAT de source, ACL de sortie. La réponse est dé-traduite par la table des traductions du ping. Le routeur répond en ARP pour ses adresses de NAT statique et de pool. Quand un routeur d'Internet reçoit un paquet vers une adresse privée, NetCanvas rappelle qu'il faut du NAT sur le routeur de bordure. Containerlab : `iptables -t nat` (MASQUERADE, SNAT, DNAT), vérifié par de vrais pings.

**DHCP** :
- **Serveurs** : routeur ou switch niveau 3 (`ip dhcp pool` : `network`, `default-router`, `dns-server` ; `ip dhcp excluded-address`), serveur Server-PT (formulaire), MikroTik (`/ip pool`, `/ip dhcp-server`, `/ip dhcp-server network`).
- **Relais** : `ip helper-address`.
- **Clients** : PC en « Automatique (DHCP) » ou `ipconfig /renew`.
- **Attribution** : la demande est diffusée dans le VLAN du client. Le premier serveur ou relais répond, avec la première adresse libre du pool (sans les exclues, les adresses statiques ni les baux déjà donnés).
- **Échec** : le PC prend une adresse 169.254.x.x (APIPA), et NetCanvas explique pourquoi (pas de serveur ni de relais dans le VLAN, relais vers une adresse injoignable, pas de pool pour le réseau du relais, pool épuisé).
- **Affichage** : `show ip dhcp binding`, `/ip dhcp-server lease print`, `ipconfig` avec le serveur DNS. Containerlab installe les baux calculés.

**Temps simulé** (horloge de la barre du haut : +1 min, +1 h, +1 j, ↺) : l'état d'exécution (temps, baux DHCP, table NAT) est enregistré avec le schéma.
- **Baux DHCP datés** : `lease` (1 jour par défaut, `lease infinite`), `lease-time` MikroTik. Un PC connecté renouvelle à mi-bail et garde son adresse. Un PC débranché ou supprimé garde son bail jusqu'à expiration, ce qui reproduit un vrai pool épuisé par des baux fantômes. `clear ip dhcp binding *|A` libère, `ipconfig /release` rend l'adresse jusqu'au prochain `/renew`. `show ip dhcp binding` et `/ip dhcp-server lease print` affichent l'expiration.
- **Table NAT persistante** : chaque ping ou traceroute ajoute ses entrées ICMP (identifiant comme « port » du PAT), visibles dans `show ip nat translations` et effacées par `clear ip nat translation *`. Elles expirent après 60 s comme sur IOS. Seule une réponse suit une traduction dynamique : un ping non sollicité venu d'Internet ne traverse pas le PAT, seul le NAT statique le permet.

**Tables ARP et MAC** : chaque interface a une adresse MAC stable, avec l'OUI de son constructeur : Cisco `0001.42xx.xxxx`, PC `00-e0-f7-…`, MikroTik `4C:5E:0C:…`. Une sous-interface a la MAC de sa parente, une SVI celle du switch.

Les tables se remplissent comme sur un vrai réseau :
- la requête ARP diffusée fait apprendre l'émetteur à tous les switches du VLAN (sur leur port d'entrée) ;
- la cible apprend l'émetteur ;
- la réponse fait apprendre la cible le long du chemin.

Au ping suivant, le journal indique « ARP (en cache) ». Durées de vieillissement :

| Table | Durée |
|---|---|
| Table MAC d'un switch | 5 min |
| ARP d'un routeur Cisco | 4 h |
| ARP d'un PC | 2 min |
| ARP d'un MikroTik | 30 s |

Commandes :
- IOS : `show arp` / `show ip arp`, `show mac address-table` (et `show mac-address-table`), `show interfaces [X]` (MAC, état, débit, encapsulation), `clear arp-cache`, `clear mac address-table dynamic` ;
- PC : `arp -a`, `arp -d` ;
- RouterOS : `/ip arp print`, `/interface print` (colonne MAC-ADDRESS).

**Simulation pas à pas** (bouton « Pas à pas », ou « Revoir trame par trame » après un ping) : le ping est découpé en trames, comme le mode Simulation de Packet Tracer :
- la requête ARP diffusée allume tous les câbles qu'elle parcourt, puis la réponse revient ;
- chaque trame ICMP avance d'un câble à la fois ;
- au retour, plus d'ARP : les deux côtés ont appris les adresses à l'aller.

Pour chaque trame, on voit les en-têtes (Ethernet II, 802.1Q sur un trunk, ARP, HDLC sur une liaison série, IPv4, ICMP) et ce que l'équipement émetteur a décidé (route choisie, NAT, ACL). On y suit la réécriture des MAC à chaque routeur, le TTL qui baisse et l'adresse source changée par le NAT. Navigation au clavier avec les flèches ← →.

**Onglet Tables** : toutes les tables de l'équipement sélectionné (routage, cache ARP, table MAC, traductions NAT, baux DHCP distribués, voisins OSPF, sessions BGP), avec l'âge et l'expiration de chaque entrée, et un bouton « Vider ». Disponible aussi en lecture seule.

Pas encore simulé (le terminal le dit) : EIGRP, STP, DNS.

## Import de configuration (`src/cli/import.js`)

Bouton « Importer une config… » dans l'inspecteur d'un routeur ou d'un switch : on colle la sortie de `show running-config` (Cisco) ou de `/export` (MikroTik), ou on choisit un fichier. Chaque ligne passe par le terminal simulé, avec les mêmes contrôles que si on la tapait. Un aperçu donne les lignes appliquées et les lignes ignorées, avec leur numéro et la raison. Option : remplacer la config actuelle ou l'ajouter.

Comme sur IOS, une commande inconnue dans un sous-mode (`interface`, `router ospf`…) est essayée en mode global : une config se colle d'un bloc, sans `exit`. Sont ignorés sans bruit :
- les en-têtes (`Building configuration`, `version`, `!`, `end`) ;
- les bannières ;
- le bloc `interface Vlan1` par défaut des switches.

Quand une section est refusée (interface absente du modèle), ses lignes indentées sont ignorées avec elle et signalées comme telles. Les lignes sans effet sur la simulation (`service`, `duplex`, `crypto`…) sont acceptées comme dans le terminal.

Le test d'aller-retour exporte la config de chaque routeur et switch des démos, la réimporte sur un équipement vierge et vérifie que la config obtenue est identique.

## Mode TP (`src/net/exercise.js`, onglet « TP »)

Un schéma peut porter un exercice : un titre, une consigne et des objectifs vérifiés en direct à chaque modification. Types d'objectifs :

| Objectif | Atteint quand |
|---|---|
| Ping qui doit réussir | le ping simulé arrive et revient |
| Ping qui doit échouer | le ping est bloqué (ACL, isolation de VLAN) |
| Bail DHCP | l'hôte est en DHCP et a obtenu un bail |
| Adjacence OSPF | les deux routeurs sont voisins |
| Session BGP | la session vers ce voisin est Established |
| Route | le routeur a une route qui couvre le préfixe (un résumé ou une route par défaut compte) |
| Aucune erreur | les contrôles ne signalent aucune erreur |

Indices progressifs pour l'élève : 1. l'objectif n'est pas atteint ; 2. l'équipement où ça bloque (bouton « Voir ») ; 3. l'explication du simulateur.

Parcours : l'enseignant règle le réseau qui marche, ajoute les objectifs (tous verts), introduit les pannes et partage le lien de lecture. L'élève clique « Dupliquer pour modifier » et répare dans son brouillon. Deux TP sont fournis dans le menu Démos (inter-VLAN, OSPF), avec trois pannes chacun.

## Matériel et câblage (`src/net/catalog.js`, `src/net/cabling.js`)

| Catégorie | Modèles |
|---|---|
| Routeurs | Cisco 1941, 2901, 2911, ISR 4321, routeur générique (cuivre, fibre, série) |
| MikroTik | hAP ac², RB4011, CCR2004-16G-2S+, CHR (virtuel) : ports `etherN` / `sfp-sfpplus`, auto-MDIX (droit ou croisé, les deux marchent) |
| Switches | Cisco 2960-24TT, 2960-48TT, switch générique (avec 2 ports fibre), hub |
| Switches niveau 3 | Cisco 3560-24PS, 3650-24PS : interfaces VLAN (SVI), `ip routing`, routes statiques, OSPF / RIP / BGP |
| Hôtes | PC, ordinateur portable, serveur, imprimante |
| Externe | Internet |

**Modules** (onglet Propriétés d'un routeur) : HWIC-2T (2 ports série) et HWIC-1GE-SFP (1 port fibre) pour les 1941 / 2901 / 2911, NIM-2T et NIM-1GE-CU-SFP pour l'ISR 4321. Changer de modèle ou retirer un module est refusé si un port câblé disparaîtrait.

**Câbles** : on choisit l'outil dans la palette, puis on relie deux équipements. Les ports libres sont pris automatiquement, et on peut les changer en cliquant sur le câble.

| Câble | Règle |
|---|---|
| Auto | pose le bon câble sur les premiers ports libres compatibles |
| Droit | cuivre entre familles différentes : PC ↔ switch, routeur ↔ switch |
| Croisé | cuivre entre équipements de même famille : PC ↔ PC, PC ↔ routeur, switch ↔ switch |
| Fibre | entre deux ports fibre (SFP) |
| Série | entre deux routeurs ; le premier relié est le côté DCE, qui doit avoir un clock rate |
| Console | RS232 d'un PC ↔ port Console : sert à configurer, ne transporte pas de trafic |

Un câble hors service coupe vraiment le réseau : le ping échoue à cet endroit avec la raison, et l'erreur apparaît dans les contrôles.

## Modèle de simulation (`src/net/`)

| Niveau | Règle |
|---|---|
| Câble | un câble hors service ne transmet rien ; une interface de routeur sur un câble down sort de la table de routage |
| Hôte | même réseau que la destination → envoi direct, sinon → passerelle (qui doit être dans son réseau) |
| Routeur | plus long préfixe parmi réseaux connectés et routes statiques ; à égalité, le connecté gagne ; TTL décrémenté |
| ARP / niveau 2 | parcours en largeur du domaine de diffusion : un port access étiquette avec son VLAN, un trunk transporte tout (VLAN 1 sans étiquette), un port access jette une trame étiquetée, un hub répète tout |
| Retour | l'echo reply refait tout le chemin inverse : une route de retour manquante est détectée |

Pas encore modélisé : router-on-a-stick (sous-interfaces), NAT, ACL, STP.

## Partage par lien (sans compte)

Le bouton **Partager** enregistre le schéma en ligne (Supabase) et donne trois liens :
- **lecture seule** `…/?d=abc123` : on regarde et on simule (ping, traceroute) sans rien pouvoir modifier ; « Dupliquer pour modifier » en fait une copie locale ;
- **édition** `…/?d=abc123#edit=jeton` : chaque modification est enregistrée en ligne une seconde après ;
- **intégration** `…/?d=abc123&embed=1` : plan et panneau seuls, à mettre dans une iframe (Moodle, Notion, wiki).

Sécurité :
- **Table** : `diagrams`, sécurité par lignes (RLS) activée et aucune politique, donc aucun accès direct.
- **Fonctions** : trois seulement, `create_diagram`, `get_diagram` et `update_diagram`, qui vérifient le format et la taille (2 Mo maximum).
- **Jeton d'édition** : la base ne garde que son empreinte SHA-256. Il est placé après le `#`, donc jamais envoyé au serveur web ni écrit dans ses journaux. Il est aussi gardé dans le navigateur (« Mes partages »).
- **Clé dans `.env`** : c'est une clé « publishable », publique par nature.

Un schéma partagé ouvert n'écrase jamais le brouillon local (« Retour à mon brouillon »).

```bash
npm run test:share   # contre la vraie base (npm run dev lancé) : création, enregistrement, lecture seule verrouillée, édition, lien inconnu
```

## Exports (onglet « Export »)

| Format | Contenu |
|---|---|
| NetCanvas (JSON) | le schéma complet, réimportable |
| Cisco Packet Tracer | un bloc `enable / configure terminal … write memory` par routeur et switch Cisco, à coller dans l'onglet CLI ; la config IP des PC en commentaire ; script RouterOS pour un MikroTik (absent de Packet Tracer, signalé) |
| GNS3 | script RouterOS des MikroTik (appliance CHR, routage compris), startup-config des routeurs c7200 (loopbacks, `router ospf|rip|bgp` avec les interfaces renumérotées) (interfaces renumérotées `Fa0/0`, `Fa0/1`, `Fa1/0`…), tableau des ports du switch Ethernet intégré, commandes VPCS |
| Containerlab | `.clab.yml` avec des conteneurs Linux : routeurs (`ip_forward`, loopbacks, routes), switches (bridge avec filtrage VLAN), hôtes. Les conteneurs n'exécutent pas OSPF/RIP/BGP : les routes de l'état convergé calculé par NetCanvas y sont installées en statique |
| Plan d'adressage (CSV) | une ligne par interface : IP, masque, réseau, passerelle, VLAN, voisin. Séparateur `;` et BOM UTF-8 pour Excel |
| draw.io | schéma modifiable avec les formes Cisco de diagrams.net |
| SVG / PNG | image sur fond clair (PNG en x2), pour un rapport |

Les exports Cisco signalent ce qui ne passera pas tel quel : interface absente du matériel par défaut (ex. `G0/3` sur un 2911), plus de 26 ports sur un 2960, interface sans IP.

Pas encore exporté : sous-interfaces (router-on-a-stick), NAT, ACL, puisque le simulateur ne les gère pas non plus.

## Format JSON (v3)

```json
{
  "format": "netcanvas", "version": 2, "name": "Mon réseau",
  "devices": [
    { "id": "pc1", "type": "pc", "model": "PC-PT", "label": "PC Compta", "position": { "x": 0, "y": 0 },
      "config": { "ip": "192.168.10.10", "mask": 24, "gateway": "192.168.10.1" } },
    { "id": "r1", "type": "router", "model": "2911", "modules": { "0": "HWIC-2T" }, "label": "R1", "position": { "x": 0, "y": 0 },
      "config": { "interfaces": [{ "link": "l4", "name": "G0/0", "ip": "192.168.10.1", "mask": 24 },
                                 { "link": "l6", "name": "Se0/0/0", "ip": "10.0.0.1", "mask": 30, "clockRate": 64000 }],
                  "routes": [{ "network": "0.0.0.0", "mask": 0, "nextHop": "10.0.0.2" }] } },
    { "id": "sw1", "type": "switch", "model": "2960-24TT", "label": "SW", "position": { "x": 0, "y": 0 },
      "config": { "ports": [{ "link": "l1", "name": "Fa0/1", "mode": "access", "vlan": 10 }] } }
  ],
  "links": [
    { "id": "l1", "source": "pc1", "target": "sw1", "sourceHandle": "r", "targetHandle": "l",
      "cable": "straight", "sourceIface": "Fa0", "targetIface": "Fa0/1" },
    { "id": "l6", "source": "r1", "target": "r2", "cable": "serial", "sourceIface": "Se0/0/0", "targetIface": "Se0/0/0", "dce": "source" }
  ]
}
```

Champs facultatifs d'une interface : `shutdown`, `description`, `clockRate`. Une interface configurée sans câble a `"link": null`. Un switch peut avoir `"vlans": [{ "id": 30, "name": "Invites" }]`.

Les fichiers v1 et v2 s'importent toujours : le modèle est déduit des ports utilisés (2911 si possible, sinon un modèle plus grand) et le câble adapté est posé. Le document se stocke tel quel dans une colonne `jsonb` PostgreSQL.

## Tests

```bash
npm test           # 156 tests : calculs IP, ping, validation, JSON, TP, câblage, OSPF / RIP / BGP, terminaux IOS / RouterOS / PC, exports
npm run test:e2e   # navigateur réel (nécessite `npm run dev` lancé) : édition, contrôles, ping, persistance, exports, câblage, terminaux (IOS, RouterOS, PC), démos OSPF et BGP (show ip ospf neighbor, next-hop-self retiré)
```

`src/export/containerlab.netns.test.js` monte l'export Containerlab sur un vrai réseau Linux, sans Docker ni root : un namespace réseau par équipement (`unshare -rnm`), des paires veth pour les câbles, puis les commandes générées. Les pings réels doivent donner le même verdict que le simulateur (VLAN, inter-VLAN, 2 routeurs, mauvais VLAN, trunk, démos OSPF et BGP avec les routes calculées). Le test est ignoré si les namespaces utilisateur sont indisponibles.

## Prochaines étapes

1. Simulation : STP (boucles de switches), DNS.
2. Partage : historique des versions, expiration des liens, comptes utilisateurs (« Mes schémas »).

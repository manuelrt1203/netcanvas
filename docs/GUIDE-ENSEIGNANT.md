# NetCanvas : guide enseignant

NetCanvas est un simulateur réseau dans le navigateur (ou en application de bureau) : les étudiants configurent des routeurs, des switches et des PC, et l'application vérifie le résultat en direct. Rien à installer sur le site : https://netcanvas.vercel.app

## 1. Préparer un TP en 10 minutes

1. **Construire le réseau** : glisser les équipements, les câbler, ou **importer un projet GNS3** (Fichier > Importer depuis GNS3 : `.gns3project` ou dossier de projet). Les configurations IOS des routeurs Dynamips sont reprises.
2. **Configurer le réseau juste** (terminal IOS ou formulaires). C'est le corrigé.
3. Onglet **TP** > *Créer un TP* : titre, consigne, puis des **objectifs**. Tous doivent être verts sur le réseau juste.
4. **Casser le réseau** (ou le remettre à l'état initial : interfaces seulement) pour obtenir le sujet.
5. Enregistrer (`.netcanvas`) ou partager le lien : l'étudiant clique « Dupliquer pour modifier ».

### Objectifs disponibles (21)
Ping réussi / bloqué · bail DHCP · nom DNS résolu · page web · trafic traduit par NAT · adjacence OSPF · voisinage EIGRP · session BGP · route (IPv4 / IPv6) · route apprise par RIP · **chemin BGP préféré** (par quel voisin sort le trafic) · **attribut du meilleur chemin BGP** (local-pref, MED, weight, longueur d'AS_PATH) · switch root STP · port bloqué STP · EtherChannel · VLAN appris par VTP · port coupé par port-security · ACL appliquée · aucune erreur dans les contrôles.

Chaque objectif a un **poids** (1 par défaut) : la note de l'examen est la somme des points des objectifs atteints rapportée à 20.

L'étudiant a des **indices progressifs** (l'objectif n'est pas atteint, l'équipement où ça bloque, l'explication du simulateur).

## 2. Faire passer un examen

Dans l'onglet TP : *Créer un examen chronométré*. Le schéma actuel (avec ses pannes) devient le sujet.

- Durée (1 à 600 min), indices autorisés ou non, progression visible ou non.
- **Sujet personnel par étudiant** : adresses privées et numéros de VLAN changés automatiquement, avec le même comportement. Une réponse copiée d'un voisin ne valide pas les objectifs.
- **Journal d'actions** : commandes tapées, modifications, collages, textes copiés, sorties de la fenêtre. Indice pour le prof, pas preuve ; l'étudiant en est informé.
- Vous obtenez deux liens : **étudiants** (`?exam=…`) et **suivi** (`#admin=…`, à garder pour vous).
- Suivi : tableau des copies (note, objectifs, durée, retard, résumé du journal), ouverture d'une copie, chronologie du journal, export CSV avec le détail par objectif, clôture.
- Les notes sont recalculées chez vous à partir du schéma rendu et des objectifs du sujet : une copie ne peut pas se donner des points.

Conseil : faites d'abord le TP vous-même en mode élève (lien en lecture, « Dupliquer pour modifier ») pour vérifier que les pannes sont réparables.

### Séance de TP en direct (sans note)

Dans l'onglet TP : *Lancer une séance en direct*. Les étudiants ouvrent le lien, saisissent leur nom et travaillent sur le TP ; vous voyez leur avancement objectif par objectif, en direct, et l'objectif le moins réussi de la classe (à reprendre au tableau). Seule la progression remonte, **jamais leur schéma**. La séance expire au bout de 24 h ; vous pouvez la clore ou la supprimer avant.

### Supprimer un examen

Dans le suivi de l'examen (ou « Mon compte » → Mes examens) : *Supprimer l'examen et les copies*. C'est définitif : exportez d'abord les notes (CSV).

## 3. Données et vie privée

Les examens stockent le nom saisi par l'étudiant, son schéma rendu et le journal d'actions, dans un projet Supabase (UE). Rien d'autre. Pensez à indiquer la durée de conservation à vos étudiants et à supprimer l'examen une fois les notes validées (bouton « Supprimer l'examen et les copies »). Les séances en direct ne gardent que le nom et la progression, et disparaissent après 24 h.

## 4. Séance en salle : check-list

- Tester l'accès à https://netcanvas.vercel.app depuis le réseau de l'IUT (le partage et le temps réel passent par Supabase : `*.supabase.co`, HTTPS et WebSocket).
- Navigateur récent (Chrome, Edge, Firefox). L'application de bureau (Windows, macOS, Linux) fonctionne sans connexion pour tout sauf le partage et les examens.
- Un compte enseignant (facultatif) retrouve ses examens depuis « Mon compte ».
- Le projet Supabase gratuit est réveillé automatiquement deux fois par semaine (`keepalive.yml`). Si les liens ne s'ouvrent plus, vérifier l'état du projet dans le tableau de bord Supabase.

## 5. Ce que NetCanvas simule

Voir [FIDELITE.md](FIDELITE.md) : fonctions couvertes, mesures de fidélité contre du vrai IOS, limites connues.

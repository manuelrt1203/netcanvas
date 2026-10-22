# Démonstration de 5 minutes (TP BGP)

Matériel : le dossier `NetCanvas/` des TP BGP (sujet et corrigé de chaque topologie) et le navigateur ouvert sur https://netcanvas.vercel.app.

**1. Un vrai TP du cours (1 min).** Fichier > Ouvrir `TP4-BGP-attribut-MED-sujet.netcanvas`. Onglet TP : la consigne et 9 objectifs, tous rouges : seules les interfaces sont configurées. « Ce sont vos topologies GNS3, importées avec leurs configurations. »

**2. Le terminal IOS (1 min).** Clic sur R2 > Terminal. Taper `show ip bgp summary` : session à l'état Active avec l'explication de ce qui manque. Montrer `show ip bgp | include 1.1.1.1` et `show ip route 1.1.1.1` : les filtres et les commandes de détail marchent comme sur IOS.

**3. Objectifs en direct (1 min).** Ouvrir le corrigé (`…-corrige.netcanvas`) : objectifs verts. Dans le terminal de R4 : `show ip bgp 1.1.1.1` (deux chemins, MED 20 et 10) ; sur R2, retirer la route-map `setmetric` : l'objectif « R4 sort par R6 » passe au rouge, avec l'indice et l'explication.

**4. Fidélité (30 s).** « Les tables BGP de ces TP ont été comparées à du vrai IOS (Dynamips, c3640) : mêmes chemins préférés, mêmes MED, mêmes métriques EIGRP. » (Détails dans `docs/FIDELITE.md`.)

**5. L'examen (1 min 30).** Onglet TP > Créer un examen : cocher « sujet personnel » et « journal d'actions ». Ouvrir le lien étudiant dans une fenêtre privée, saisir un nom : les adresses de l'objectif ne sont plus celles du sujet. Rendre la copie, revenir au suivi : note pondérée, colonne Journal, export CSV avec le détail par objectif.

**À dire en conclusion** : gratuit, sans installation côté étudiant, TP et examens corrigés automatiquement, notes non falsifiables, une variante par étudiant.

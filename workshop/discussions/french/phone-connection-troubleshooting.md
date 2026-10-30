# Impossible de se connecter depuis un téléphone ou une tablette ?

> Ceci est une traduction de la discussion du Workshop Steam [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Pour poser une question ou signaler un problème, laissez un commentaire dans cette discussion — inutile d'écrire en anglais, vous pouvez écrire en français.

Essayez ces étapes si votre téléphone ou votre tablette ne se connecte pas. Pour un plantage ou un problème pendant une partie, consultez [Un problème ? Signalez-le dans la discussion Steam](reporting-a-problem.md).

### 1. Choisissez les paramètres de connexion

Sur l’ordinateur qui fait tourner le jeu, ouvrez **Code QR de Couch Co-Op**.

- **Interface réseau** (à gauche) : choisissez **Filaire (Ethernet)** si l’ordinateur est relié au routeur par câble, ou **Wi-Fi** s’il est connecté sans fil. Choisissez la connexion au routeur qu’utilise votre téléphone. Ignorez **Nom du PC (.local)**.
- **Méthode de connexion** (à droite) : choisissez **Adresse directe**, sans « (HTTPS) ». L’adresse doit commencer par `http://`, par exemple `http://192.168.1.5:13337`.

Scannez de nouveau le code QR après avoir modifié ces paramètres.

Utilisez **Adresse directe** pendant le dépannage. Les méthodes HTTPS sont des options pour les performances et la sécurité, avec une configuration ou des conditions de connexion supplémentaires.

### 2. Vérifiez le réseau du téléphone

- Connectez le téléphone au Wi-Fi de la maison, pas au réseau **Invité**. L’ordinateur peut utiliser le Wi-Fi ou un câble vers le même routeur.
- Vérifiez que le téléphone utilise le Wi-Fi plutôt que les données mobiles.
- Déconnectez temporairement tout VPN sur le téléphone ou l’ordinateur. Cela comprend les bloqueurs de publicité du téléphone qui utilisent une connexion VPN.

**Si la page s’ouvre mais que la connexion à la partie reste bloquée, passez à l’étape 6.**

### 3. Windows : autorisez le jeu à travers le pare-feu

Sur votre réseau domestique :

1. **Paramètres > Réseau et Internet > Wi-Fi** (ou Ethernet) > cliquez sur votre réseau > réglez **Type de profil réseau** sur **Réseau privé**.
2. **Paramètres > Confidentialité et sécurité > Sécurité Windows > Pare-feu et protection réseau > Autoriser une application via le pare-feu**
3. Trouvez **Slay the Spire 2** dans la liste et vérifiez que **Privé** est coché. S'il n'est pas dans la liste, utilisez **Autoriser une autre application...** et parcourez jusqu'au fichier `.exe` du jeu.

Si vous avez précédemment annulé la demande du pare-feu pour le jeu, supprimez son entrée bloquée et ajoutez le jeu de nouveau.

Si votre antivirus possède son propre pare-feu, autorisez le jeu dans celui-ci aussi.

Ouvrir l’adresse sur l’ordinateur qui fait tourner le jeu ne permet pas de vérifier si le pare-feu autorise votre téléphone à se connecter.

### 4. Vérifiez si le navigateur impose HTTPS

La méthode **Adresse directe** utilise `http://`. Si votre navigateur tente de remplacer ce début par `https://`, vérifiez son réglage de connexion sécurisée :

- Chrome : **Paramètres > Confidentialité et sécurité > Sécurité > Toujours utiliser une connexion sécurisée**
- Firefox : **Paramètres > Vie privée et sécurité > Sécurité logicielle et des connexions > Paramètres avancés > Mode HTTPS uniquement**

Autorisez l’adresse HTTP, puis scannez de nouveau le code QR. Gardez **Adresse directe** sélectionné sur l’ordinateur.

### 5. Vérifiez le routeur

Le Wi-Fi invité empêche souvent les appareils de communiquer entre eux. Utilisez le réseau principal de la maison.

Si les deux appareils sont déjà sur ce réseau, vérifiez si **AP isolation**, **Client isolation** ou **Wireless isolation** est activé sur le routeur. Ces réglages empêchent les appareils de communiquer entre eux.

Si vous utilisez un répéteur Wi-Fi, vérifiez qu’il est en mode **point d’accès** (access point) ou **pont** (bridge), plutôt que de créer un réseau séparé.

### 6. Si la page s’ouvre mais que rejoindre la partie prend du temps

Lancer la partie d’un joueur peut prendre jusqu’à une minute. Gardez la page ouverte tant que la ligne de progression sous **Connexion…** change d’étape.

Si une erreur apparaît, faites une capture d’écran ou copiez son texte exact, y compris la petite ligne grise éventuelle.

Si la page reste sur **Connexion…** ou **Chargement…** sans erreur, indiquez le dernier message de progression dans votre commentaire.

### 7. Si cela fonctionnait avant

L’adresse de l’ordinateur a peut-être changé après une reconnexion au réseau ou un redémarrage du routeur. Ouvrez l’écran du code QR et scannez de nouveau.

Si un ancien favori ou raccourci sur l’écran d’accueil ne fonctionne plus, remplacez-le avec l’adresse que vous venez de scanner.

---

## Toujours bloqué ? Commentez dans la discussion Steam

Dans [la discussion Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/), commencez par indiquer :

- Jusqu’où cela va : aucune page, aucune liste de joueurs, connexion ou chargement bloqué, ou déconnexion pendant la partie.
- Une capture d’écran ou le message d’erreur exact.
- Le système d’exploitation de l’ordinateur, le modèle du téléphone et le navigateur.
- Si tous les téléphones échouent ou un seul.

### Copiez le rapport de connexion

Sur l’ordinateur, ouvrez **Code QR de Couch Co-Op**, puis regardez sous **Connexions**. Sélectionnez la connexion en échec sous **Problèmes de connexion**, choisissez **Copier le rapport** et collez le rapport dans votre commentaire.

Si aucune connexion n’y apparaît, dites-le et donnez les informations ci-dessus.

Le rapport contient les chemins des fichiers journaux utiles. Si des journaux sont nécessaires, [Un problème ? Signalez-le dans la discussion Steam](reporting-a-problem.md) explique comment les trouver. Avant de publier des journaux, retirez votre identifiant de compte Steam et votre nom d’utilisateur sur l’ordinateur si vous préférez les garder privés.

Utilisez le mod sur un réseau de confiance : toute personne pouvant accéder à l’adresse de connexion peut ouvrir le client et jouer.

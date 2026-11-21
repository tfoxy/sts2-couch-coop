# ¿Tienes algún problema? Publícalo en la discusión de Steam

> Esta es una traducción de la discusión del Workshop de Steam [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Para hacer una pregunta o reportar un problema, deja un comentario en esa discusión. No necesitas escribir en inglés: puedes hacerlo en español.

Publica en [la discusión de Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) si algo falla: un cierre inesperado, un jugador que no termina de unirse, algo que se ve mal en pantalla o una partida que deja de funcionar.

**Si tu teléfono o tablet ni siquiera puede abrir la página para unirse**, lee primero [¿No puedes conectarte desde un teléfono o una tablet?](phone-connection-troubleshooting.md). La mayoría de los problemas de conexión se deben a un ajuste de la red Wi-Fi, el firewall o el router que se explica en esa guía.

### Antes de reportar un bloqueo al unirse

Iniciar el juego de un jugador puede tardar hasta un minuto, sobre todo en una computadora más lenta. Mientras la línea debajo de **Uniéndote…** en la página para unirse siga contando y cambiando, sigue trabajando, así que deja la página abierta.

---

## Qué incluir

No necesitas responder todo. Los dos primeros puntos son los que más ayudan.

### 1. Qué pasó y qué esperabas que pasara

Con una o dos oraciones alcanza. Si apareció un error, cópialo exactamente, incluida la línea gris más pequeña que hay abajo, o publica una captura o una foto de la pantalla.

### 2. El informe de conexión (problemas al unirse o en la sala)

*Omite este punto si el problema ocurrió durante una partida.*

En la computadora, abre **Código QR de Couch Co-Op** y busca **Conexiones**. Selecciona la conexión que falló en **Problemas de conexión**, elige **Copiar informe** y pégalo en tu comentario.

El informe indica qué paso falló y cuánto tardó cada uno, incluye lo que el anfitrión cree que falló y muestra las rutas de los archivos de registro de abajo.

### 3. Los archivos de registro

Si copiaste el informe de conexión, ya contiene las rutas exactas.

**El registro del juego**, en la computadora anfitriona:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**Los registros de los jugadores.** Cada jugador que se une ejecuta su propia copia oculta del juego en la computadora anfitriona, con su propio registro. Si un jugador se quedó trabado al unirse, su registro suele explicar por qué; el del juego normalmente no lo explica.

El primer jugador que se une es `slot-2`, el siguiente `slot-3` y así sucesivamente. Para `slot-2`:

- Windows: `%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-2\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/couch-coop/headless-slots/slot-2/Library/Application Support/SlayTheSpire2/logs/godot.log`

Si no hay una carpeta `headless-slots`, el registro es `couch-coop/seat-logs/slot-2.log`, dentro de la misma carpeta `SlayTheSpire2` que el registro del juego.

**Qué líneas importan.** En ambos registros, las líneas que más necesito son las que contienen `[couchcoop]` (por ejemplo, `[INFO] [couchcoop] ...`), además de cualquier línea `[ERROR]`, aunque no mencione couchcoop. Normalmente con esas líneas alcanza.

**Antes de pegar un registro completo:** esta discusión es pública. Un registro contiene tu SteamID64 (un número largo que empieza con 7656 y lleva a tu perfil de Steam) y el nombre de usuario de tu computadora en las rutas de archivo. No contiene contraseñas ni cuentas de otros jugadores. Si prefieres no compartir esos dos datos, reemplázalos antes de pegarlo o publica solo las líneas `[couchcoop]` y `[ERROR]` y, si necesito más, te lo pediré.

### 4. Versiones y mods

- Si estás en la rama **estable** o en la rama **beta pública** del juego.
- **Qué otros mods tienes instalados.** La copia del juego de cada jugador carga los mismos mods que el anfitrión, así que otro mod puede impedir que un jugador se una aunque el juego del anfitrión funcione bien.
- El sistema operativo del anfitrión.
- Tu versión de CouchCoop, si la sabes. Si no, voy a suponer que es la más reciente.

### 5. Cualquier cosa que ayude a acotarlo

- ¿Pasa siempre o solo a veces?
- ¿Le pasa a todos los jugadores o solo a uno?
- ¿Funcionaba antes y cambió algo desde entonces, como una actualización del juego o un mod nuevo?

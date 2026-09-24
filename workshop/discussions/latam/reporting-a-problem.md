# ¿Tienes algún problema? Publícalo en la discusión de Steam

> Esta es una traducción de la discusión del Workshop de Steam [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Para hacer una pregunta o reportar un problema, deja un comentario en esa discusión. No necesitas escribir en inglés: puedes hacerlo en español.

[La discusión de Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) es el lugar para cualquier cosa que salga mal: cierres inesperados, un jugador que nunca termina de unirse, algo que se ve mal en pantalla, una partida que se rompe.

**Si tu teléfono o tablet ni siquiera llega a la página para unirse**, lee primero [¿No puedes conectarte desde un teléfono o una tablet?](phone-connection-troubleshooting.md): ahí se explican en detalle la red Wi-Fi, los firewalls y los routers, y la mayoría de los problemas de conexión se resuelven ahí.

---

## Qué incluir

No necesitas responder todo: los dos primeros puntos valen más que todos los demás juntos.

### 1. Qué pasó y qué esperabas que pasara

Con una o dos oraciones alcanza. Si apareció un mensaje de error en pantalla, cópialo exactamente, incluida cualquier línea gris más pequeña que haya abajo. Una foto o una captura de pantalla es perfecta.

### 2. Si el problema es al unirse o en la sala: el informe de conexión

*Si tu problema ocurre más tarde (durante una partida o en el propio juego), pasa directamente al paso 3.*

Desde la sala, abre la pantalla **Código QR de Couch Co-Op**. El panel **Conexiones** está ahí, debajo del código. Todo lo que salió mal se guarda en **Problemas de conexión** (con un número al lado).

Selecciona la fila que falló, presiona **Copiar informe** y pégalo en tu comentario. Si el problema es al unirse, es lo más útil que puedes adjuntar: ya incluye el paso que falla, los tiempos, el diagnóstico del propio anfitrión y las rutas de los archivos de registro que se describen más abajo.

### 3. Los archivos de registro

Hay dos tipos, y cuál importa depende del problema.

**El registro principal del juego**, en la computadora anfitriona:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**El registro de cada jugador.** Cada jugador que se une tiene su propia copia del juego corriendo en segundo plano en la computadora anfitriona, y cada una guarda su propio registro. **Si un jugador se quedó trabado al unirse, este es el archivo que explica por qué**; el registro principal de arriba normalmente no lo explica.

Los jugadores se numeran a partir del 2, así que la primera persona que se une a tu partida es **`slot-2`**. En Linux, el registro de ese jugador está en:

`~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`

(Sí, `SlayTheSpire2` de verdad aparece dos veces; no es un error de tipeo). En Windows y macOS la estructura es la misma, dentro de la carpeta de la lista de arriba. En algunas configuraciones, en cambio, es un solo archivo en `couch-coop/seat-logs/slot-2.log`. En cualquier caso, **el informe del paso 2 indica la ruta exacta**, así que si lo copias primero te ahorras buscarla.

**Qué líneas importan.** En cualquiera de los dos archivos, las útiles contienen `[couchcoop]` (se ven así: `[INFO] [couchcoop] ...`), además de cualquier línea `[ERROR]`, aunque no mencione couchcoop. Normalmente con esas líneas alcanza.

**Antes de pegar un registro completo:** la discusión de Steam es pública, y un registro contiene tu propio **SteamID64** (un número largo que empieza con 7656 y que lleva a tu perfil de Steam) y el **nombre de usuario** de tu computadora, en las rutas de archivo. *No* contiene contraseñas, y tampoco contiene las cuentas de otros jugadores: solo la tuya. Si prefieres no publicar eso, alcanza con usar buscar y reemplazar en esos dos datos antes de pegarlo, o publica solo las líneas `[couchcoop]` y `[ERROR]` y, si necesito más, te lo pido.

### 4. Versiones y mods

- Si estás en la rama **estable** o en la rama **beta pública** del juego.
- **Qué otros mods tienes instalados.** Cada copia de jugador en segundo plano carga los mismos mods que el anfitrión, así que otro mod puede impedir que un jugador termine de unirse aunque la partida del propio anfitrión se vea perfectamente bien.
- El sistema operativo del anfitrión.
- La versión de CouchCoop, si la sabes; si no, voy a suponer que es la más reciente.

### 5. Cualquier cosa que ayude a acotarlo

- ¿Pasa siempre o solo a veces?
- ¿Le pasa a todos los jugadores o solo a uno?
- ¿Alguna vez funcionó, y cambió algo desde entonces, como una actualización del juego o un mod nuevo?

---

## Algo que conviene saber antes de reportar

Iniciar la partida de un jugador puede tardar hasta un minuto, y en una computadora más lenta va a usar casi todo ese tiempo. Es normal, no una falla. Mientras trabaja, la página para unirse va contando y cambiando de etapa debajo de *Uniéndote…*; si esa línea sigue moviéndose, todavía no falló nada, así que deja la página abierta.

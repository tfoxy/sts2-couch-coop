# ¿No puedes conectarte desde un teléfono o una tablet?

> Esta es una traducción de la discusión del Workshop de Steam [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Para hacer una pregunta o reportar un problema, deja un comentario en esa discusión. No necesitas escribir en inglés: puedes hacerlo en español.

La mayoría de los problemas de conexión se reducen a unas pocas causas. Esta lista está ordenada, más o menos, de la más común a la menos común, así que vale la pena revisarla en orden.

*Si tu teléfono llega sin problemas a la página para unirse y el problema es otro (un cierre inesperado, un jugador que nunca termina de unirse, algo que anda mal en el propio juego), revisa [¿Tienes algún problema? Publícalo en la discusión de Steam](reporting-a-problem.md).*

---

## Cosas que puedes probar

### 1. Elige otra dirección en la pantalla del QR

La pantalla del QR tiene un selector con varias formas de llegar al anfitrión. Si la que escaneaste no funciona, elige otra y vuelve a escanear.

Usa de preferencia la dirección numérica simple (algo como **192.168.1.5:13337**). Es la que tiene menos piezas que puedan fallar. El nombre **.local** y el enlace web dependen de cosas externas al mod (tu router, una conexión a internet, los permisos del navegador), así que pueden fallar en una red donde la dirección numérica funciona perfectamente.

**En un iPhone o iPad, no uses para nada la opción *Enlace web*.** Safari (y cualquier otro navegador de iOS, porque en el fondo todos son Safari) no permite que una página cargada desde internet acceda a nada de tu red de casa. Es una regla del navegador, no una configuración, así que no hay nada que permitir ni nada que cambiar: la página va a cargar y después te va a decir que el juego no respondió, en cualquier red y sin importar cómo esté configurado tu firewall. En un iPhone o iPad, usa **Dirección simple** o **Enlace seguro**. (Ahora la propia página te lo avisa, si llegas hasta ahí).

### 2. Revisa que el teléfono realmente esté en la misma red

- En la misma red Wi-Fi que la computadora anfitriona, y no en la red de **invitados**. Las redes de invitados suelen impedir que los dispositivos se comuniquen entre sí, que es justo lo que se necesita aquí.
- Sin usar datos móviles. Si la red Wi-Fi no tiene acceso a internet, a veces los teléfonos se cambian solos a datos móviles sin avisarte.
- **Desactiva cualquier VPN del teléfono.** Esto le pasa a muchísima gente. También cuentan los bloqueadores de anuncios y las apps de "DNS privado" que funcionan como VPN.

### 3. Lee lo que te dice la página mientras se une

Iniciar la partida de un jugador puede tardar hasta un minuto, y eso es normal, no una falla. Mientras tanto, la página ahora te muestra en qué punto va, en una línea debajo de *Uniéndote…*:

*Conectando con el anfitrión: paso 1 de 6, 14 s hasta ahora. Esto puede tardar hasta un minuto, así que deja esta página abierta.*

Si esa línea va contando y cambiando de etapa, está funcionando: deja la página abierta. Las seis etapas son: conectando con el anfitrión, esperando al anfitrión, iniciando el juego de este jugador, conectando a este jugador con la partida, cargando la vista del juego y casi listo.

### 4. Si se detiene, ahora la página te dice POR QUÉ

Cuando algo realmente sale mal, tu dispositivo recibe un aviso que indica cuál de varios problemas sin relación entre sí ocurrió, en dos oraciones más una línea técnica en gris. **Incluye todo eso en cualquier reporte.** Hay tres posibles, y cada uno necesita una solución totalmente diferente:

- “**Tu juego está en marcha en la computadora anfitriona, pero este dispositivo no pudo conectarse a él.**”\
  Es la ruta de red entre tu teléfono y el anfitrión: una red Wi-Fi de invitados, una VPN o un router que mantiene aislados los dispositivos. La partida del anfitrión no tiene ningún problema. Revisa las secciones 2 y 6.
- “**Otro programa de la computadora anfitriona está usando el puerto que necesita tu juego.**”\
  No hay nada que cambiar en tu dispositivo. En el anfitrión, algo más está ocupando uno de los puertos que necesita cada jugador; casi siempre es un proceso de jugador que quedó abierto de una sesión anterior. Quien sea el anfitrión debe cerrarlo (reiniciar Slay the Spire 2 lo resuelve).
- “**La computadora anfitriona está bloqueando el puerto que usa tu juego.**”\
  Tampoco hay nada que cambiar en tu dispositivo. Lo está bloqueando el propio firewall o el software de seguridad del anfitrión; revisa la sección 5.

**El caso de bloqueo más común ni siquiera muestra *Uniéndote…*.** Si tu dispositivo llegó al anfitrión pero no puede llegar al puerto que se le asignó a tu propio jugador, la unión *funciona*, y después la página cambia a *Cargando…* y se queda ahí. En esa pantalla no hay línea de progreso ni cuenta regresiva, porque, del lado del anfitrión, nada falló. Lo primero útil que vas a ver es el mensaje “**no pudo conectarse a él**” de arriba, unos **20 segundos** después de que cambie la página. Así que, si te quedas trabado en *Cargando…*, espera medio minuto a que aparezca ese mensaje en vez de recargar: si recargas, toda la espera vuelve a empezar.

Si, en cambio, se queda en *Uniéndote…* y nunca cambia, el anfitrión se rinde a los 75 segundos con *No se pudo iniciar la vista del juego. Inténtalo de nuevo.* y una línea gris debajo. Esa es una falla distinta de la anterior. En cualquier caso, copia lo que diga.

### 5. Cada jugador usa su propio puerto

La sala está en el **13337**, y luego cada jugador usa el **13357**, el **13367**, el **13377** y así sucesivamente. Una regla de firewall que solo abre el 13337 te deja llegar a la lista de jugadores y después falla en el segundo paso. Si agregaste una (por tu cuenta o siguiendo una guía), bórrala y, en su lugar, permite **el programa del juego**: eso cubre todos los puertos que necesita.

### 6. Windows: permite el juego en el firewall

Primero revisa el tipo de red, porque esto solo ya bloquea muchas conexiones:

- **Configuración > Red e Internet > Wi-Fi** (o Ethernet) > haz clic en tu red > cambia **Tipo de perfil de red** a **Red privada**.

Después, permite el juego:

- **Configuración > Privacidad y seguridad > Seguridad de Windows > Firewall y protección de red > Permitir a una aplicación atravesar el firewall**
- Busca **Slay the Spire 2** en la lista y verifica que la casilla **Privada** esté marcada. Si no aparece en la lista, usa **Permitir otra aplicación...** y busca el `.exe` del juego.

Si en algún momento respondiste "Cancelar" a un aviso del firewall de Windows, Windows lo recuerda como una regla de bloqueo y nunca más te va a volver a preguntar. En ese caso, tienes que borrar la entrada de arriba y volver a agregarla.

**Abrir la dirección en un navegador de la propia computadora anfitriona no prueba nada.** Es lo primero que se le ocurre a cualquiera, y está comprobado que engaña: Windows no filtra el tráfico de una computadora hacia sí misma (ni siquiera hacia su propia dirección de red), así que, aunque el firewall esté bloqueando activamente todos los teléfonos, el navegador del propio anfitrión carga la página perfectamente. Si a ti te funcionó, eso te dice que el juego está corriendo y sirviendo la página. No dice absolutamente nada sobre el firewall.

Marca **Pública** solo si tu red está configurada como pública y no puedes cambiarla. Si la marcas, el juego queda accesible en cualquier red a la que te conectes, incluidas las de cafeterías y hoteles.

### 7. El router

Algunos routers impiden que los dispositivos conectados a la misma red Wi-Fi se comuniquen entre sí. Busca una opción llamada **AP isolation**, **Client isolation** o **Wireless isolation** (en español, "aislamiento AP") y desactívala.

También es bueno saber que un repetidor Wi-Fi o un adaptador powerline configurado en modo **router** en vez de en modo **bridge** / **access point** (puente / punto de acceso) pone tu teléfono en una red distinta de la del anfitrión, aunque el nombre de la red Wi-Fi se vea igual.

### 8. Configuraciones del navegador que bloquean las direcciones simples

Algunos navegadores intentan forzar HTTPS en todas las direcciones, y la dirección numérica simple no lo usa. (La opción **Enlace seguro** de la pantalla del QR sí lo usa, así que, si el problema es que se fuerza HTTPS, también vale la pena probarla). Si la barra de direcciones muestra una advertencia de seguridad en vez del juego, desactiva estas opciones y vuelve a intentarlo:

- Chrome: **Configuración > Privacidad y seguridad > Seguridad > Usar siempre conexiones seguras**
- Firefox: **Ajustes > Privacidad y seguridad > Seguridad de la conexión y del software > Configuración avanzada > Modo solo HTTPS**

En iPhone, revisa también **Configuración > *tu nombre* > iCloud > Retransmisión privada** y "Ocultar dirección IP" en **Configuración > Apps > Safari**.

### 9. Antivirus con su propio firewall

Los paquetes de seguridad como ESET, Bitdefender, Norton, Kaspersky y Avast tienen su propio firewall, aparte del de Windows. Permitir el juego en Windows no sirve de nada con ellos. Revisa la configuración de red o de firewall del propio antivirus, o pausa su firewall un momento para ver si eso es lo que lo está bloqueando.

### 10. Si antes funcionaba y dejó de funcionar

La dirección de la computadora anfitriona puede cambiar cuando vuelve a conectarse a la red Wi-Fi o después de reiniciar el router. Abre otra vez la pantalla del QR y vuelve a escanear: ahí va a estar la nueva dirección.

Si agregaste el cliente a la pantalla de inicio, lo que pase después depende de la opción desde la que lo instalaste:

- Instalado desde la opción **Enlace web**: sigue funcionando y encuentra la nueva dirección por su cuenta. Solo ábrelo, no hace falta volver a escanear.
- Instalado desde la **dirección numérica** o desde **Enlace seguro**: el ícono apunta a la dirección vieja y no puede recuperarse. Bórralo y vuelve a agregarlo después de escanear de nuevo. (En Android, instalarlo desde la opción **Enlace web** evita esto para siempre. En un iPhone o iPad esa opción no puede funcionar, como se explica en la sección 1, así que volver a agregar el ícono es la única forma).

---

## ¿Sigue sin funcionar? Comenta en la discusión de Steam

Deja un comentario en [la discusión de Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/); no necesitas responder todo. Con solo una o dos de estas respuestas, el reporte ya es mucho más fácil de resolver, y la primera pregunta vale más que todas las demás juntas.

### ¿Hasta dónde llega?

Es lo más útil que me puedes decir, porque cada respuesta apunta a una causa diferente:

- el navegador nunca carga nada
- la página carga, pero la lista de jugadores nunca aparece
- puedes elegir un nombre, pero se queda en “Uniéndote…”: dime qué decía la línea de progreso de abajo y qué mensaje te apareció si esperaste
- pasa de ahí y se queda en “**Cargando…**”: este es el caso del puerto o del firewall, y es el más común. Dime si apareció el mensaje “no pudo conectarse a él” después de unos 20 segundos
- se conectó bien y después se desconectó durante la partida

### Cualquier otra cosa que puedas agregar

- El mensaje exacto que muestra el teléfono, incluida la línea gris de abajo. Una foto de la pantalla es perfecta.
- Qué dirección escaneaste: la numérica, el nombre **.local** o el enlace web.
- El sistema operativo del anfitrión, y el modelo y el navegador del teléfono o la tablet.
- ¿Falla en **todos** los dispositivos o solo en uno? Si un teléfono funciona y otro no, eso descarta muchas cosas.
- ¿Alguna vez funcionó, y cambió algo desde entonces?
- Si el anfitrión está conectado por Wi-Fi o por Ethernet. Si hay alguna VPN activa en el anfitrión o en el teléfono. Si hay algún antivirus con firewall.

### Tres cosas que te puede dar la computadora anfitriona

- **El panel de conexiones.** En el anfitrión, abre la pantalla **Código QR de Couch Co-Op**: el panel **Conexiones** está ahí, debajo del código. Aparecen los dispositivos que llegaron lo suficientemente lejos, y todo lo que salió mal se guarda en **Problemas de conexión** (con un número al lado). Selecciona la fila y usa **Copiar informe**: eso copia un informe que ya incluye el paso que falla, los tiempos y el diagnóstico del propio anfitrión. Pégalo directamente en tu comentario. También indica la ruta exacta de los dos archivos de registro de abajo, así te ahorras buscarlos.
- **El archivo de registro principal.** En Windows, `%APPDATA%\SlayTheSpire2\logs\godot.log`. En Linux, `~/.local/share/SlayTheSpire2/logs/godot.log`. En macOS, `~/Library/Application Support/SlayTheSpire2/logs/godot.log`.
- **El registro de cada jugador.** Cada jugador que se une tiene su propia copia del juego corriendo en segundo plano en el anfitrión, y cada una guarda su propio registro. **Si la unión llegó a *Uniéndote…* y después se agotó el tiempo de espera, este es el archivo que explica por qué**; el registro principal de arriba normalmente no lo explica. Los jugadores se numeran a partir del 2, así que la primera persona que se une es **`slot-2`**: en Linux, es `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log` (sí, `SlayTheSpire2` dos veces; no es un error de tipeo), y las rutas de Windows y macOS siguen la misma estructura dentro de sus carpetas de arriba. En algunas configuraciones, en cambio, es un solo archivo en `couch-coop/seat-logs/slot-2.log`.

**Qué líneas importan.** En cualquiera de los dos registros, las útiles contienen `[couchcoop]` (se ven así: `[INFO] [couchcoop] ...`), además de cualquier línea `[ERROR]`, aunque no mencione couchcoop. Normalmente con esas alcanza.

**Antes de pegar un registro completo:** la discusión de Steam es pública, y un registro contiene tu propio **SteamID64** (un número largo que empieza con 7656 y que lleva a tu perfil de Steam) y el **nombre de usuario** de tu computadora, en las rutas de archivo. *No* contiene contraseñas, y tampoco contiene las cuentas de otros jugadores: solo la tuya. Si prefieres no publicar eso, alcanza con usar buscar y reemplazar en esos dos datos antes de pegarlo, o publica solo las líneas `[couchcoop]` y `[ERROR]` y, si necesito más, te lo pido.

---

Una última advertencia: cualquiera que pueda acceder a la dirección para unirse puede abrir el cliente y jugar, así que úsalo en una red de confianza.

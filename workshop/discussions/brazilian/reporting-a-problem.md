# Está com algum problema? Poste na discussão da Steam

> Esta é uma tradução da discussão da Oficina Steam [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Para fazer uma pergunta ou relatar um problema, deixe um comentário nessa discussão — não precisa escrever em inglês, pode escrever em português.

Poste na [discussão da Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) se algo der errado: um crash, um jogador que não consegue terminar de entrar, algo aparecendo errado na tela ou uma partida que para de funcionar.

**Se o seu celular ou tablet não consegue nem abrir a página de entrada**, leia primeiro [Não consegue se conectar pelo celular ou tablet?](phone-connection-troubleshooting.md). A maioria dos problemas de conexão vem de uma configuração do Wi-Fi, do firewall ou do roteador explicada nesse guia.

### Antes de relatar um travamento ao entrar

Iniciar o jogo de um jogador pode levar até um minuto, principalmente em um computador mais lento. Enquanto a linha abaixo de **Entrando…** na página de entrada continuar contando e mudando, o carregamento ainda está em andamento, então mantenha a página aberta.

---

## O que incluir

Não precisa responder tudo. Os dois primeiros itens são os que mais ajudam.

### 1. O que aconteceu e o que você esperava que acontecesse

Uma ou duas frases bastam. Se apareceu um erro, copie exatamente, incluindo a linha cinza menor abaixo dele, ou poste uma captura ou foto da tela.

### 2. O relatório de conexão (problemas ao entrar ou na sala)

*Pule este item se o problema aconteceu durante uma partida.*

No computador, abra **Código QR do Couch Co-Op** e procure **Conexões**. Selecione a conexão que falhou em **Problemas de conexão**, escolha **Copiar relatório** e cole no seu comentário.

Ele informa qual etapa falhou e quanto tempo cada uma levou, inclui o que o host acha que deu errado e lista os caminhos dos arquivos de log abaixo.

### 3. Os arquivos de log

Se você copiou o relatório de conexão, ele já lista os caminhos exatos.

**O log do jogo**, no computador do host:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**Os logs dos jogadores.** Cada jogador que entra executa sua própria cópia oculta do jogo no computador do host, com seu próprio log. Se um jogador travou ao entrar, o log dele geralmente explica o motivo; o do jogo normalmente não explica.

O primeiro jogador que entra é `slot-2`, o seguinte é `slot-3` e assim por diante. Para `slot-2`:

- Windows: `%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-2\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/couch-coop/headless-slots/slot-2/Library/Application Support/SlayTheSpire2/logs/godot.log`

Se não houver uma pasta `headless-slots`, o log é `couch-coop/seat-logs/slot-2.log`, dentro da mesma pasta `SlayTheSpire2` do log do jogo.

**Quais linhas importam.** Nos dois logs, as linhas de que mais preciso são as que contêm `[couchcoop]` (por exemplo, `[INFO] [couchcoop] ...`), além de qualquer linha `[ERROR]`, mesmo que não mencione couchcoop. Normalmente essas linhas bastam.

**Antes de colar um log inteiro:** esta discussão é pública. Um log contém seu SteamID64 (um número longo que começa com 7656 e leva ao seu perfil da Steam) e o nome de usuário do seu computador nos caminhos de arquivo. Ele não contém senhas nem contas de outros jogadores. Se preferir não compartilhar esses dois dados, substitua antes de colar ou poste só as linhas `[couchcoop]` e `[ERROR]`, e eu peço mais se precisar.

### 4. Versões e mods

- Se você está no ramo **estável** ou no ramo de **beta pública** do jogo.
- **Quais outros mods você instalou.** A cópia do jogo de cada jogador carrega os mesmos mods que o host, então outro mod pode impedir um jogador de entrar mesmo quando o jogo do host funciona bem.
- O sistema operacional do host.
- Sua versão do CouchCoop, se você souber. Senão, vou supor que é a mais recente.

### 5. Qualquer coisa que ajude a identificar o problema

- Acontece sempre ou só às vezes?
- Acontece com todos os jogadores ou só com um?
- Funcionava antes? Mudou alguma coisa desde então, como uma atualização do jogo ou um mod novo?

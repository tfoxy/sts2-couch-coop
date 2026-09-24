# Está com algum problema? Poste na discussão da Steam

> Esta é uma tradução da discussão da Oficina Steam [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Para fazer uma pergunta ou relatar um problema, deixe um comentário nessa discussão — não precisa escrever em inglês, pode escrever em português.

A [discussão da Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) é o lugar para qualquer coisa que dê errado — crashes, um jogador que nunca termina de entrar, algo aparecendo errado na tela, uma partida que quebra.

**Se o seu celular ou tablet não consegue nem chegar à página de entrada**, leia primeiro [Não consegue se conectar pelo celular ou tablet?](phone-connection-troubleshooting.md) — lá estão explicados em detalhes Wi-Fi, firewalls e roteadores, e a maioria dos problemas de conexão se resolve por lá.

---

## O que incluir

Não precisa responder tudo — os dois primeiros itens valem mais do que todo o resto junto.

### 1. O que aconteceu, e o que você esperava que acontecesse

Uma ou duas frases bastam. Se apareceu uma mensagem de erro na tela, copie-a exatamente, incluindo qualquer linha cinza menor abaixo dela. Uma foto ou captura de tela é perfeita.

### 2. Se o problema for ao entrar ou na sala: o relatório de conexão

*Se o seu problema acontece mais tarde — durante uma partida ou no próprio jogo —, pule direto para o passo 3.*

Na sala, abra a tela **Código QR da cooperativa de sofá**. O painel **Conexões** fica nela, abaixo do código. Tudo o que deu errado fica guardado em **Problemas de conexão** (com um número depois).

Selecione a linha que falhou e pressione **Copiar relatório**, depois cole no seu comentário. Para um problema ao entrar, essa é a coisa mais útil que você pode anexar: ela já contém a etapa que falhou, os tempos, o diagnóstico do próprio host e os caminhos dos arquivos de log descritos abaixo.

### 3. Os arquivos de log

Há dois tipos, e qual deles importa depende do problema.

**O log principal do jogo**, no computador do host:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**O log de cada jogador.** Cada jogador que entra ganha a sua própria cópia do jogo rodando em segundo plano no computador do host, e cada uma mantém o seu próprio log. **Se um jogador travou ao entrar, este é o arquivo que explica o motivo** — o log principal acima normalmente não explica.

Os jogadores são numerados a partir de 2, então a primeira pessoa que entra na sua partida é **`slot-2`**. No Linux, o log desse jogador fica em:

`~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`

(Sim, `SlayTheSpire2` aparece mesmo duas vezes — não é erro de digitação.) No Windows e no macOS o formato é o mesmo, dentro da pasta da lista acima. Em algumas configurações, em vez disso, é um único arquivo em `couch-coop/seat-logs/slot-2.log`. De qualquer forma, **o relatório do passo 2 informa o caminho exato**, então copiá-lo primeiro poupa você de ter que procurar.

**Quais linhas importam.** Em qualquer um dos arquivos, as úteis contêm `[couchcoop]` — elas têm esta cara: `[INFO] [couchcoop] ...` —, além de qualquer linha `[ERROR]`, mesmo as que não mencionam couchcoop. Normalmente essas linhas bastam sozinhas.

**Antes de colar um log inteiro:** a discussão da Steam é pública, e um log contém o seu próprio **SteamID64** (um número longo que começa com 7656 e leva ao seu perfil da Steam) e o **nome de usuário** do seu computador, nos caminhos de arquivo. Ele *não* contém senhas, e não contém as contas de outros jogadores — só a sua. Se preferir não publicar isso, basta usar localizar e substituir nesses dois dados antes de colar, ou publique só as linhas `[couchcoop]` e `[ERROR]`, e eu peço mais se precisar.

### 4. Versões e mods

- Se você está no ramo **estável** ou no ramo de **beta pública** do jogo.
- **Quais outros mods estão instalados.** Cada cópia de jogador em segundo plano carrega os mesmos mods que o host, então outro mod pode impedir que um jogador termine de entrar mesmo quando o jogo do próprio host parece perfeitamente normal.
- O sistema operacional do host.
- A versão do CouchCoop, se você souber — senão, vou supor que é a mais recente.

### 5. Qualquer coisa que ajude a restringir

- Acontece sempre ou só às vezes?
- Acontece com todos os jogadores ou só com um?
- Já funcionou antes? Mudou alguma coisa desde então — uma atualização do jogo, um mod novo?

---

## Uma coisa que vale saber antes de relatar

Iniciar o jogo de um jogador pode levar até um minuto, e numa máquina mais lenta ele vai usar a maior parte desse tempo. Isso é normal, não um defeito. Enquanto está trabalhando, a página de entrada vai contando e mudando de etapa abaixo de *Juntando-se…* — se essa linha ainda estiver se mexendo, nada deu errado ainda, então mantenha a página aberta.

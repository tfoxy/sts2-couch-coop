# 문제가 생겼나요? Steam 토론에 올려 주세요

> 이 글은 Steam 창작마당 토론 [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/)의 번역입니다. 질문이 있거나 문제를 알리려면 그 토론에 댓글을 남겨 주세요. 영어로 쓰지 않아도 되며, 한국어로 쓰셔도 괜찮습니다.

크래시, 참여를 끝내지 못하는 플레이어, 잘못 표시되는 화면, 진행할 수 없게 된 런 등 문제가 생기면 [Steam 토론](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/)에 글을 올려 주세요.

**휴대폰이나 태블릿에서 참여 페이지가 아예 열리지 않는다면** 먼저 [휴대폰이나 태블릿에서 연결이 안 되나요?](phone-connection-troubleshooting.md) 문서를 읽어 보세요. 대부분의 연결 문제는 그 문서에서 설명하는 Wi-Fi, 방화벽, 공유기 설정과 관련이 있습니다.

### 참여 도중 멈췄다고 알리기 전에

플레이어의 게임을 시작하는 데는 최대 1분까지 걸릴 수 있으며, 특히 느린 컴퓨터에서는 시간이 더 걸립니다. 참여 페이지의 **참여 중…** 아래 줄에서 시간이 계속 올라가고 표시가 바뀌고 있다면 아직 처리 중이니 페이지를 열어 두세요.

---

## 알려 주실 내용

모든 질문에 답할 필요는 없습니다. 처음 두 가지가 가장 도움이 됩니다.

### 1. 무슨 일이 있었는지, 어떻게 될 거라고 예상했는지

한두 문장이면 충분합니다. 오류가 떴다면 그 아래의 작은 회색 줄까지 포함해 정확히 그대로 옮겨 적거나 스크린샷 또는 화면 사진을 올려 주세요.

### 2. 연결 보고서 (참여나 로비 문제)

*런 도중에 문제가 생겼다면 이 단계는 건너뛰세요.*

컴퓨터에서 **Couch Co-Op QR 코드**를 연 다음 **연결** 항목을 보세요. **연결 문제** 아래에서 실패한 연결을 선택하고 **보고서 복사**를 선택한 뒤 댓글에 붙여 넣으세요.

보고서에는 실패한 단계와 각 단계에 걸린 시간, 호스트가 판단한 문제 원인, 그리고 아래에서 설명하는 로그 파일의 경로가 나옵니다.

### 3. 로그 파일

연결 보고서를 복사했다면 정확한 경로가 이미 거기에 나와 있습니다.

**게임 로그**(호스트 컴퓨터에 있음):

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**플레이어별 로그**. 참여하는 플레이어마다 호스트 컴퓨터에서 별도의 게임 사본이 보이지 않게 실행되며, 각 사본은 자체 로그를 남깁니다. 플레이어가 참여 도중 멈췄다면 보통 그 플레이어의 로그에서 이유를 알 수 있습니다. 게임 로그에는 보통 나오지 않습니다.

처음 참여한 플레이어는 slot-2, 다음은 slot-3이며 그 뒤로도 순서대로 번호가 붙습니다. slot-2의 경로:

- Windows: `%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-2\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/couch-coop/headless-slots/slot-2/Library/Application Support/SlayTheSpire2/logs/godot.log`

`headless-slots` 폴더가 없다면 로그는 게임 로그와 같은 `SlayTheSpire2` 폴더 안의 `couch-coop/seat-logs/slot-2.log`에 있습니다.

**중요한 줄**. 두 로그에서 제가 가장 필요로 하는 것은 `[couchcoop]`이 포함된 줄(예: `[INFO] [couchcoop] ...`)과 모든 `[ERROR]` 줄입니다. couchcoop이 언급되지 않은 `[ERROR]` 줄도 포함해 주세요. 보통 이 정도면 충분합니다.

**로그 전체를 붙여 넣기 전에**: 이 토론은 공개되어 있습니다. 로그에는 본인의 SteamID64(7656으로 시작하는 긴 숫자로, Steam 프로필로 연결됩니다)와 파일 경로 속 컴퓨터 사용자 이름이 들어 있습니다. 비밀번호나 다른 플레이어의 계정은 들어 있지 않습니다. 이 두 가지를 공개하고 싶지 않다면 붙여 넣기 전에 바꾸거나 `[couchcoop]`과 `[ERROR]` 줄만 올려 주세요. 더 필요하면 제가 물어보겠습니다.

### 4. 버전과 모드

- 게임의 **안정** 브랜치인지 **공개 베타** 브랜치인지.
- **설치한 다른 모드**. 각 플레이어의 게임 사본은 호스트와 같은 모드를 불러옵니다. 따라서 호스트의 게임이 잘 작동해도 다른 모드 때문에 플레이어가 참여하지 못할 수 있습니다.
- 호스트의 운영 체제.
- 알고 있다면 CouchCoop 버전. 모르면 최신 버전으로 간주하겠습니다.

### 5. 원인을 좁히는 데 도움이 되는 것

- 매번 일어나나요, 아니면 가끔만 일어나나요?
- 모든 플레이어에게 일어나나요, 아니면 한 명에게만 일어나나요?
- 전에는 잘 됐나요? 그 이후로 게임 업데이트나 새 모드 등 바뀐 것이 있나요?

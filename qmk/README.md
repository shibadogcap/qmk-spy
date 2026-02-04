# QMK-SPY Secret Storage (QMK)

このフォルダには WebHID 側と通信するための QMK 実装が含まれます。

## 使い方（概要）

1. `secret_storage.c` と `secret_storage.h` をキーマップ配下に配置
2. `rules.mk` に以下を追加
   - `SRC += secret_storage.c`
   - `RAW_ENABLE = yes`

必要に応じてストレージサイズやベースアドレスなどを調整してください。

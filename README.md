# QMK-SPY

Author: shibadogcap

QMK WebHID でストレージを読み書きするツールと、対応する QMK 側の C 実装を分離して同梱したリポジトリです。

## Web アプリ

- 場所: web/
- 起動手順:
  1. `npm install`
  2. `npm run dev`

## QMK 側 C 実装

- 場所: qmk/
- 内容: `secret_storage.c`, `secret_storage.h`
- 取り込みの目安:
  - `keyboards/<your_keyboard>/keymaps/<your_keymap>/` に配置
  - `rules.mk` に `SRC += secret_storage.c` を追加
  - `RAW_ENABLE = yes` を有効化

必要に応じて各キーボードの構成に合わせて調整してください。

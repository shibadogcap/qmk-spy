#pragma once

#include "quantum.h"

// 秘密ストレージ操作中の入力ブロックと緊急中断を処理
// true: 通常処理を継続
// false: このキーは処理済み（ブロック）
bool secret_storage_process_record_user(uint16_t keycode, keyrecord_t *record);

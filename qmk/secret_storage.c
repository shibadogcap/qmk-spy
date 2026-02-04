#include QMK_KEYBOARD_H
#include "raw_hid.h"
#include "secret_storage.h"
#include "hardware/flash.h"
#include "hardware/sync.h"
#include <string.h>

#define SECRET_CMD_INFO  0xA0
#define SECRET_CMD_READ  0xA1
#define SECRET_CMD_WRITE 0xA2
#define SECRET_CMD_ERASE 0xA3

#define SECRET_STATUS_OK        0x00
#define SECRET_STATUS_ERR       0x01
#define SECRET_STATUS_BUSY      0x02
#define SECRET_STATUS_RANGE     0x03
#define SECRET_STATUS_ALIGN     0x04
#define SECRET_STATUS_ABORT     0x05

#define SECRET_MAX_READ  28
#define SECRET_MAX_WRITE 26

#define SECRET_STORAGE_BASE (PICO_FLASH_SIZE_BYTES - WEAR_LEVELING_BACKING_SIZE - SECRET_STORAGE_SIZE)

_Static_assert(SECRET_STORAGE_SIZE > 0, "SECRET_STORAGE_SIZE must be > 0");
_Static_assert((SECRET_STORAGE_SIZE % FLASH_SECTOR_SIZE) == 0, "SECRET_STORAGE_SIZE must be sector aligned");
_Static_assert((WEAR_LEVELING_BACKING_SIZE % FLASH_SECTOR_SIZE) == 0, "WEAR_LEVELING_BACKING_SIZE must be sector aligned");
_Static_assert((SECRET_STORAGE_BASE % FLASH_SECTOR_SIZE) == 0, "SECRET_STORAGE_BASE must be sector aligned");
_Static_assert((SECRET_STORAGE_SIZE + WEAR_LEVELING_BACKING_SIZE) <= PICO_FLASH_SIZE_BYTES, "Secret storage + wear leveling exceeds flash size");

static volatile bool secret_busy  = false;
static volatile bool secret_abort = false;
static uint8_t       secret_sector_buf[FLASH_SECTOR_SIZE];

static inline uint32_t read_u32_be(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static inline void write_u32_be(uint8_t *p, uint32_t v) {
    p[0] = (v >> 24) & 0xFF;
    p[1] = (v >> 16) & 0xFF;
    p[2] = (v >> 8) & 0xFF;
    p[3] = v & 0xFF;
}

static inline uint32_t secret_flash_offset(uint32_t offset) {
    return SECRET_STORAGE_BASE + offset;
}

static void secret_read_bytes(uint32_t offset, uint8_t *dst, uint32_t length) {
    const uint8_t *src = (const uint8_t *)(XIP_BASE + secret_flash_offset(offset));
    memcpy(dst, src, length);
}

static __not_in_flash_func(bool) secret_erase_range(uint32_t offset, uint32_t length) {
    if ((offset % FLASH_SECTOR_SIZE) != 0 || (length % FLASH_SECTOR_SIZE) != 0) {
        return false;
    }

    uint32_t start = secret_flash_offset(offset);
    uint32_t end   = start + length;

    for (uint32_t addr = start; addr < end; addr += FLASH_SECTOR_SIZE) {
        if (secret_abort) {
            return false;
        }
        uint32_t irq = save_and_disable_interrupts();
        flash_range_erase(addr, FLASH_SECTOR_SIZE);
        restore_interrupts(irq);
    }

    return true;
}

static __not_in_flash_func(bool) secret_write_bytes(uint32_t offset, const uint8_t *src, uint32_t length) {
    uint32_t addr = secret_flash_offset(offset);

    while (length > 0) {
        if (secret_abort) {
            return false;
        }

        uint32_t sector_start  = addr & ~(FLASH_SECTOR_SIZE - 1);
        uint32_t sector_offset = addr - sector_start;
        uint32_t chunk         = FLASH_SECTOR_SIZE - sector_offset;
        if (chunk > length) {
            chunk = length;
        }

        memcpy(secret_sector_buf, (const void *)(XIP_BASE + sector_start), FLASH_SECTOR_SIZE);
        memcpy(secret_sector_buf + sector_offset, src, chunk);

        uint32_t irq = save_and_disable_interrupts();
        flash_range_erase(sector_start, FLASH_SECTOR_SIZE);
        for (uint32_t i = 0; i < FLASH_SECTOR_SIZE; i += FLASH_PAGE_SIZE) {
            flash_range_program(sector_start + i, secret_sector_buf + i, FLASH_PAGE_SIZE);
        }
        restore_interrupts(irq);

        addr += chunk;
        src += chunk;
        length -= chunk;
    }

    return true;
}

bool secret_storage_process_record_user(uint16_t keycode, keyrecord_t *record) {
    if (secret_busy) {
        if (record->event.pressed && keycode == KC_ESC) {
            secret_abort = true;
        }
        return false;
    }

    return true;
}

void raw_hid_receive_kb(uint8_t *data, uint8_t length) {
    (void)length;

    uint8_t req[32];
    memcpy(req, data, 32);

    uint8_t base = 0;
    uint8_t cmd  = req[0];
    if (cmd != SECRET_CMD_INFO && cmd != SECRET_CMD_READ && cmd != SECRET_CMD_WRITE && cmd != SECRET_CMD_ERASE) {
        const uint8_t shifted = req[1];
        if (shifted == SECRET_CMD_INFO || shifted == SECRET_CMD_READ || shifted == SECRET_CMD_WRITE || shifted == SECRET_CMD_ERASE) {
            base = 1;
            cmd  = shifted;
        } else {
            data[0] = 0xFF; // id_unhandled
            return;
        }
    }

    uint8_t *r = req + base;
    uint8_t *p = data + base;

    // 応答バッファを初期化（リクエストは req に保持）
    memset(&data[1], 0, 31);
    if (base == 1) {
        data[0] = req[0];
    }

    if (cmd == SECRET_CMD_INFO) {
        p[1] = SECRET_STATUS_OK;
        write_u32_be(&p[2], SECRET_STORAGE_SIZE);
        write_u32_be(&p[6], PICO_FLASH_SIZE_BYTES);
        write_u32_be(&p[10], WEAR_LEVELING_BACKING_SIZE);
        write_u32_be(&p[14], SECRET_STORAGE_BASE);
        p[18] = SECRET_MAX_READ;
        p[19] = SECRET_MAX_WRITE;
        return;
    }

    if (secret_busy) {
        p[1] = SECRET_STATUS_BUSY;
        return;
    }

    if (cmd == SECRET_CMD_READ) {
        uint32_t offset = read_u32_be(&r[1]);
        uint8_t  size   = r[5];

        if (size == 0 || size > SECRET_MAX_READ) {
            p[1] = SECRET_STATUS_ERR;
            return;
        }
        if (offset + size > SECRET_STORAGE_SIZE) {
            p[1] = SECRET_STATUS_RANGE;
            return;
        }

        secret_busy  = true;
        secret_abort = false;
        secret_read_bytes(offset, &p[3], size);
        secret_busy = false;

        if (secret_abort) {
            p[1] = SECRET_STATUS_ABORT;
            return;
        }

        p[1] = SECRET_STATUS_OK;
        p[2] = size;
        return;
    }

    if (cmd == SECRET_CMD_WRITE) {
        uint32_t offset = read_u32_be(&r[1]);
        uint8_t  size   = r[5];

        if (size == 0 || size > SECRET_MAX_WRITE) {
            p[1] = SECRET_STATUS_ERR;
            return;
        }
        if (offset + size > SECRET_STORAGE_SIZE) {
            p[1] = SECRET_STATUS_RANGE;
            return;
        }

        secret_busy  = true;
        secret_abort = false;
        bool ok      = secret_write_bytes(offset, &r[6], size);
        secret_busy  = false;

        if (secret_abort) {
            p[1] = SECRET_STATUS_ABORT;
            return;
        }

        p[1] = ok ? SECRET_STATUS_OK : SECRET_STATUS_ERR;
        return;
    }

    if (cmd == SECRET_CMD_ERASE) {
        uint32_t offset = read_u32_be(&r[1]);
        uint32_t size   = read_u32_be(&r[5]);

        if (size == 0) {
            p[1] = SECRET_STATUS_ERR;
            return;
        }
        if (offset + size > SECRET_STORAGE_SIZE) {
            p[1] = SECRET_STATUS_RANGE;
            return;
        }
        if ((offset % FLASH_SECTOR_SIZE) != 0 || (size % FLASH_SECTOR_SIZE) != 0) {
            p[1] = SECRET_STATUS_ALIGN;
            return;
        }

        secret_busy  = true;
        secret_abort = false;
        bool ok      = secret_erase_range(offset, size);
        secret_busy  = false;

        if (secret_abort) {
            p[1] = SECRET_STATUS_ABORT;
            return;
        }

        p[1] = ok ? SECRET_STATUS_OK : SECRET_STATUS_ERR;
        return;
    }
}

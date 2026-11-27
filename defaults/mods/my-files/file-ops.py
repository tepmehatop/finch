"""Local file operations for Finch. JSON in argv; never interprets a shell string."""
import ctypes
import errno
import json
import os
import shutil
import stat
import subprocess
import sys


WINDOWS = sys.platform == 'win32'
# Names Windows reserves for devices, with or without an extension.
RESERVED = {'con', 'prn', 'aux', 'nul', *(f'com{i}' for i in range(1, 10)), *(f'lpt{i}' for i in range(1, 10))}


def path(value):
    if not isinstance(value, str) or not os.path.isabs(value) or '\0' in value:
        raise ValueError('Нужен абсолютный путь')
    return os.path.normpath(value)


def child(parent, name):
    if not isinstance(name, str) or not name.strip() or name in ('.', '..') or '/' in name or '\0' in name:
        raise ValueError('Введите имя без /, . или ..')
    if WINDOWS and (any(c in name for c in '\\:*?"<>|') or any(ord(c) < 32 for c in name)
                    or name.endswith((' ', '.')) or name.split('.')[0].strip().lower() in RESERVED):
        raise ValueError('Windows не разрешает такое имя: без \\ : * ? " < > |, без точки или пробела в конце, не CON, NUL, COM1…')
    return os.path.join(path(parent), name)


def inside(src, dst):
    """True when dst is src itself or lies inside it (never across drives)."""
    try:
        real = os.path.realpath(src)
        return os.path.normcase(os.path.commonpath([real, os.path.realpath(dst)])) == os.path.normcase(real)
    except ValueError:  # different drives on Windows
        return False


def copy_exclusive(src, dst):
    info = os.lstat(src)
    if stat.S_ISLNK(info.st_mode):
        os.symlink(os.readlink(src), dst)
    elif stat.S_ISDIR(info.st_mode):
        if inside(src, dst):
            raise ValueError('Нельзя скопировать папку внутрь неё самой')
        shutil.copytree(src, dst, symlinks=True, copy_function=copy_exclusive)
    elif stat.S_ISREG(info.st_mode):
        with open(src, 'rb') as source, open(dst, 'xb') as target:
            shutil.copyfileobj(source, target)
        shutil.copystat(src, dst, follow_symlinks=False)
    else:
        raise ValueError('Этот тип файла не поддерживается')
    return dst


def move_exclusive(src, dst):
    if src == dst:
        return dst
    if os.path.isdir(src) and not os.path.islink(src):
        # A case-only rename (a.txt -> A.txt) is the same item, not "inside".
        if os.path.normcase(src) != os.path.normcase(dst) and inside(src, dst):
            raise ValueError('Нельзя переместить папку внутрь неё самой')
    if WINDOWS:
        # MoveFileEx without MOVEFILE_REPLACE_EXISTING: an existing name fails,
        # like RENAME_EXCL. A case-only rename of the same item is allowed.
        if os.path.lexists(dst) and os.path.normcase(src) != os.path.normcase(dst):
            raise FileExistsError(errno.EEXIST, 'exists', dst)
        try:
            os.rename(src, dst)
        except OSError as error:
            if getattr(error, 'winerror', None) == 17:  # ERROR_NOT_SAME_DEVICE
                raise ValueError('Между дисками используйте копирование, затем корзину')
            raise
        return dst
    if sys.platform != 'darwin':
        raise ValueError('Перемещение сейчас поддерживается на macOS и Windows')
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(os.fsencode(src), os.fsencode(dst), 4) != 0:  # RENAME_EXCL
        code = ctypes.get_errno()
        if code == errno.EXDEV:
            raise ValueError('Между дисками используйте копирование, затем корзину')
        raise OSError(code, os.strerror(code), dst)
    return dst


def recycle(src):
    """The Windows Recycle Bin, through the Shell. FOF_WANTNUKEWARNING makes
    Windows ask before deleting for good an item it cannot recycle (too big,
    a drive without a Recycle Bin) instead of deleting it silently."""
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [('hwnd', wintypes.HWND), ('wFunc', wintypes.UINT), ('pFrom', wintypes.LPCWSTR),
                    ('pTo', wintypes.LPCWSTR), ('fFlags', ctypes.c_ushort), ('fAnyOperationsAborted', wintypes.BOOL),
                    ('hNameMappings', ctypes.c_void_p), ('lpszProgressTitle', wintypes.LPCWSTR)]

    FO_DELETE, FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI, FOF_WANTNUKEWARNING = 3, 0x4, 0x10, 0x40, 0x400, 0x4000
    # pFrom is a list of paths ending with an empty one: two NULs at the end.
    names = ctypes.create_unicode_buffer(src + '\0')
    operation = SHFILEOPSTRUCTW(None, FO_DELETE, ctypes.cast(names, wintypes.LPCWSTR), None,
                                FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING,
                                False, None, None)
    shell32 = ctypes.WinDLL('shell32')
    shell32.SHFileOperationW.argtypes = [ctypes.POINTER(SHFILEOPSTRUCTW)]
    shell32.SHFileOperationW.restype = ctypes.c_int
    code = shell32.SHFileOperationW(ctypes.byref(operation))
    if operation.fAnyOperationsAborted:
        raise ValueError('Удаление отменено')
    if code:
        raise ValueError(f'Корзина: код {code:#x}')
    if os.path.lexists(src):
        raise ValueError('Не удалось переместить в корзину')


def operate(req):
    action = req['action']
    src = path(req['path'])
    if action == 'directory':
        if not os.path.isdir(src):
            raise ValueError('Папка не найдена')
        return {'path': src}
    if action in ('create-file', 'create-folder'):
        dst = child(src, req['name'])
        if action == 'create-file':
            with open(dst, 'x', encoding='utf-8'):
                pass
        else:
            os.mkdir(dst)
        return {'path': dst}
    if action == 'resolve':
        if not os.path.isdir(src):
            raise ValueError('Папка не найдена')
        return {'path': os.path.realpath(src)}
    if action in ('rename', 'copy', 'move', 'duplicate', 'trash'):
        home = os.path.normcase(os.path.expanduser('~'))
        if src == '/' or os.path.dirname(src) == src or os.path.normcase(src) == home:
            raise ValueError('Выберите файл или вложенную папку')
        os.lstat(src)
    if action == 'rename':
        dst = child(os.path.dirname(src), req['name'])
        return {'path': move_exclusive(src, dst), 'old': src, 'kind': 'move'}
    if action in ('copy', 'move'):
        dst = child(req['destination'], req.get('name') or os.path.basename(src))
        if action == 'copy':
            copy_exclusive(src, dst)
        else:
            move_exclusive(src, dst)
        return {'path': dst, 'old': src, 'kind': action}
    if action == 'duplicate':
        name = os.path.basename(src)
        stem, ext = (name, '') if os.path.isdir(src) else os.path.splitext(name)
        for n in range(1, 10000):
            dst = child(os.path.dirname(src), stem + ' copy' + (f' {n}' if n > 1 else '') + ext)
            if os.path.lexists(dst):
                continue
            copy_exclusive(src, dst)
            return {'path': dst, 'old': src, 'kind': 'copy'}
        raise ValueError('Не удалось подобрать свободное имя')
    if action == 'trash':
        if WINDOWS:
            recycle(src)
            return {'old': src, 'path': None, 'kind': 'trash'}
        if sys.platform != 'darwin':
            raise ValueError('Корзина сейчас поддерживается на macOS и Windows')
        result = subprocess.run(['/usr/bin/trash', '-v', src], capture_output=True, text=True)
        if result.returncode:
            raise ValueError(result.stderr.strip() or f'Корзина: код {result.returncode}')
        prefix = f'# Moved "{src}" to "'
        output = result.stdout.rstrip('\n')
        destination = output[len(prefix):-1] if output.startswith(prefix) and output.endswith('"') else None
        return {'old': src, 'path': destination, 'kind': 'trash'}
    raise ValueError('Неизвестная операция')


if __name__ == '__main__':
    # The answer carries Russian text; Finch reads it as UTF-8 on every system.
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        print(json.dumps(operate(json.loads(sys.argv[1])), ensure_ascii=False))
    except Exception as error:
        message = 'Такое имя уже существует. Исходные файлы сохранены.' if isinstance(error, FileExistsError) else str(error)
        print(json.dumps({'error': message}, ensure_ascii=False))
        sys.exit(1)

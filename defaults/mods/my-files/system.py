"""Windows system actions for the ProdAdvice mods: clipboard text, opening a
file or link, showing a file in Explorer. JSON request in argv[1], one JSON
line out. Uses the Windows API directly and never runs a shell string.
macOS does these with pbcopy, pbpaste and open, so nothing here runs there."""
import json
import os
import sys
import time

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
# Opening these would run them rather than show them.
RUNNABLE = {'.exe', '.com', '.bat', '.cmd', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ps1', '.psm1',
            '.msi', '.msp', '.msc', '.scr', '.cpl', '.hta', '.pif', '.lnk', '.url', '.reg', '.appref-ms',
            '.application', '.jar', '.py', '.pyw'}
LINKS = ('http://', 'https://', 'vscode://', 'obsidian://')


def api():
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
    user32.IsClipboardFormatAvailable.restype = wintypes.BOOL
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    user32.GetClipboardData.restype = wintypes.HANDLE
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL
    kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalFree.restype = wintypes.HGLOBAL
    return ctypes, user32, kernel32


class Clipboard:
    """Another program may hold the clipboard for a moment: retry briefly."""

    def __enter__(self):
        self.ctypes, self.user32, self.kernel32 = api()
        for _ in range(50):
            if self.user32.OpenClipboard(None):
                return self
            time.sleep(0.02)
        raise ValueError('Буфер обмена занят другой программой')

    def __exit__(self, *_):
        self.user32.CloseClipboard()


def clipboard_get():
    with Clipboard() as c:
        if not c.user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return None
        handle = c.user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return None
        pointer = c.kernel32.GlobalLock(handle)
        if not pointer:
            return None
        try:
            return c.ctypes.wstring_at(pointer)
        finally:
            c.kernel32.GlobalUnlock(handle)


def clipboard_set(text):
    if not isinstance(text, str):
        raise ValueError('Нужен текст')
    data = text.encode('utf-16-le') + b'\0\0'
    with Clipboard() as c:
        handle = c.kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not handle:
            raise ValueError('Не хватило памяти для буфера обмена')
        pointer = c.kernel32.GlobalLock(handle)
        if not pointer:
            c.kernel32.GlobalFree(handle)
            raise ValueError('Не удалось записать буфер обмена')
        c.ctypes.memmove(pointer, data, len(data))
        c.kernel32.GlobalUnlock(handle)
        c.user32.EmptyClipboard()
        # On success the clipboard owns the memory; free it only on failure.
        if not c.user32.SetClipboardData(CF_UNICODETEXT, handle):
            c.kernel32.GlobalFree(handle)
            raise ValueError('Не удалось записать буфер обмена')


def local_path(value):
    if not isinstance(value, str) or '\0' in value or not os.path.isabs(value):
        raise ValueError('Нужен абсолютный путь')
    path = os.path.normpath(value)
    if not os.path.lexists(path):
        raise ValueError('Файл не найден')
    return path


def open_target(target):
    if not isinstance(target, str) or '\0' in target:
        raise ValueError('Нечего открывать')
    if target.lower().startswith(LINKS):
        os.startfile(target)
        return
    path = local_path(target)
    if not os.path.isdir(path) and os.path.splitext(path)[1].lower() in RUNNABLE:
        raise ValueError('Программы и скрипты не запускаются отсюда. Используйте «Показать в Проводнике».')
    os.startfile(path)


def reveal(value):
    """Explorer with the item selected (an open window of that folder is reused)."""
    import ctypes
    path = local_path(value)
    ole32 = ctypes.WinDLL('ole32')
    shell32 = ctypes.WinDLL('shell32')
    shell32.ILCreateFromPathW.argtypes = [ctypes.c_wchar_p]
    shell32.ILCreateFromPathW.restype = ctypes.c_void_p
    shell32.SHOpenFolderAndSelectItems.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_uint]
    shell32.SHOpenFolderAndSelectItems.restype = ctypes.c_long
    shell32.ILFree.argtypes = [ctypes.c_void_p]
    ole32.CoInitialize(None)
    item = shell32.ILCreateFromPathW(path)
    if not item:
        raise ValueError('Проводник не нашёл этот путь')
    try:
        result = shell32.SHOpenFolderAndSelectItems(item, 0, None, 0)
    finally:
        shell32.ILFree(item)
    if result != 0:
        raise ValueError(f'Проводник не открылся (код {result & 0xFFFFFFFF:#x})')


def run(request):
    action = request.get('action')
    if action == 'clipboard-get':
        return {'text': clipboard_get()}
    if action == 'clipboard-set':
        delay = request.get('delay') or 0
        if not isinstance(delay, (int, float)) or not 0 <= delay <= 10:
            raise ValueError('Неверная задержка')
        time.sleep(delay)
        clipboard_set(request.get('text'))
        return {}
    if action == 'open':
        open_target(request.get('target'))
        return {}
    if action == 'reveal':
        reveal(request.get('path'))
        return {}
    raise ValueError('Неизвестное действие')


def main():
    # The answer carries Russian text; Finch reads it as UTF-8.
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        if sys.platform != 'win32':
            raise ValueError('system.py нужен только на Windows')
        print(json.dumps(run(json.loads(sys.argv[1])), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

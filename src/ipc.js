// Browser preview (GitHub Pages) has no Tauri host. Desktop commands must
// resolve here instead of rejecting, or the page reports unhandled promises.

export const IS_TAURI = Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);

function browserStub(command) {
  console.warn(`${command} needs the desktop app.`);
  switch (command) {
    case 'list_global_media':
      return [];
    case 'picture_recv_sources':
      return { ndi: [], spout: [], local: '' };
    case 'picture_recv_watch':
      return { ok: false, reason: 'Picture receive needs the desktop app.' };
    case 'picture_recv_frame':
      return new Uint8Array(0);
    case 'picture_send_start':
      return { started: [], errors: [{ name: 'Send', reason: 'Send needs the desktop app.' }] };
    case 'midi_list':
      return { inputs: [], outputs: [] };
    case 'delete_global_media':
      return { deleted: false, uses: [] };
    case 'default_stock_dir':
    case 'global_media_dir':
    case 'download_video':
    case 'download_audio':
    case 'transcode_media':
    case 'copy_project_asset':
    case 'write_project_asset':
    case 'read_text_file':
    case 'stage_prep_bytes':
      return '';
    default:
      return null;
  }
}

export async function invoke(command, args, options) {
  if (!IS_TAURI) return browserStub(command);
  const { invoke: desktop } = await import('@tauri-apps/api/core');
  return desktop(command, args, options);
}

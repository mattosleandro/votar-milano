'use client';

import { getSupabaseAuthClient } from './supabase';

const BUCKET_OPCOES = 'assembleia-opcoes';
const MAX_DIMENSION_PX = 1280;
const MAX_ORIGINAL_BYTES = 12 * 1024 * 1024; // 12 MB antes da compressão no navegador

/**
 * Redimensiona e comprime uma imagem no próprio navegador (Canvas -> WebP/JPEG ~80-180 KB)
 * para garantir carregamento instantâneo em 4G/5G nos 544 celulares durante a assembleia.
 */
async function otimizarImagemParaWeb(file: File): Promise<{ blob: Blob; ext: string; mime: string }> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { blob: file, ext: 'jpg', mime: file.type || 'image/jpeg' };
  }

  // Preserva GIFs animados sem achatar no canvas se estiverem abaixo de 2.5 MB
  if (file.type === 'image/gif' && file.size <= 2.5 * 1024 * 1024) {
    return { blob: file, ext: 'gif', mime: 'image/gif' };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Não foi possível ler a imagem selecionada.'));
      el.src = objectUrl;
    });

    let { naturalWidth: w, naturalHeight: h } = img;
    if (w <= 0 || h <= 0) {
      throw new Error('Imagem inválida ou corrompida.');
    }

    if (w > MAX_DIMENSION_PX || h > MAX_DIMENSION_PX) {
      const ratio = Math.min(MAX_DIMENSION_PX / w, MAX_DIMENSION_PX / h);
      w = Math.max(1, Math.round(w * ratio));
      h = Math.max(1, Math.round(h * ratio));
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { blob: file, ext: 'jpg', mime: file.type || 'image/jpeg' };
    }

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const blobWebp = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.84)
    );
    if (blobWebp && blobWebp.type === 'image/webp' && blobWebp.size > 0) {
      return { blob: blobWebp, ext: 'webp', mime: 'image/webp' };
    }

    const blobJpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85)
    );
    if (blobJpeg && blobJpeg.size > 0) {
      return { blob: blobJpeg, ext: 'jpg', mime: 'image/jpeg' };
    }

    return { blob: file, ext: 'jpg', mime: file.type || 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function fazerUploadImagemOpcaoPauta(
  file: File,
  assembleiaId?: string
): Promise<{ ok: true; url: string } | { ok: false; erro: string }> {
  const tiposAceitos = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!tiposAceitos.includes(file.type)) {
    return {
      ok: false,
      erro: 'Formato não suportado. Envie uma imagem JPG, PNG, WebP ou GIF.',
    };
  }

  if (file.size > MAX_ORIGINAL_BYTES) {
    return {
      ok: false,
      erro: 'A imagem excede o limite de 12 MB.',
    };
  }

  try {
    const otimizada = await otimizarImagemParaWeb(file);
    if (otimizada.blob.size > 5 * 1024 * 1024) {
      return {
        ok: false,
        erro: 'Mesmo após otimização, a imagem ultrapassou 5 MB. Tente uma foto menor.',
      };
    }

    const pasta = (assembleiaId || 'geral').replace(/[^a-zA-Z0-9_-]/g, '');
    const rand = Math.random().toString(36).slice(2, 10);
    const caminho = `${pasta}/${Date.now()}-${rand}.${otimizada.ext}`;

    const supabase = getSupabaseAuthClient();
    const { error } = await supabase.storage.from(BUCKET_OPCOES).upload(caminho, otimizada.blob, {
      contentType: otimizada.mime,
      cacheControl: '31536000',
      upsert: false,
    });

    if (error) {
      return {
        ok: false,
        erro: `Falha ao enviar imagem: ${error.message}`,
      };
    }

    const { data } = supabase.storage.from(BUCKET_OPCOES).getPublicUrl(caminho);
    if (!data?.publicUrl) {
      return {
        ok: false,
        erro: 'Imagem enviada, mas não foi possível obter a URL pública.',
      };
    }

    return { ok: true, url: data.publicUrl };
  } catch (err) {
    return {
      ok: false,
      erro: err instanceof Error ? err.message : 'Erro inesperado ao processar imagem.',
    };
  }
}

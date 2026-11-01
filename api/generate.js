// Urutan: model cepat dulu. Yang tidak dikenal atau lambat otomatis dilewati.
const MODELS = [
  "gemini-flash-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
];

const UKURAN_BAGIAN = 8; // soal per permintaan ke Gemini
const BATAS_WAKTU_MS = 50000; // total waktu mencoba (Vercel batas 60 detik)
const WAKTU_PER_PERCOBAAN_MS = 22000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Coba tiap model: sibuk (503/429/500) diulang sekali, lambat atau tidak ada (404) pindah model.
async function callGemini(apiKey, body, mulai) {
  const gagal = [];
  for (const model of MODELS) {
    let tanpaBerpikir = false; // true jika model menolak pengaturan berpikir
    for (let percobaan = 0; percobaan < 3; percobaan++) {
      const sisa = BATAS_WAKTU_MS - (Date.now() - mulai);
      if (sisa < 5000) {
        return { ok: false, status: 504, pesan: "Waktu habis, coba jumlah soal lebih sedikit.", gagal };
      }

      const isi = JSON.parse(JSON.stringify(body));
      isi.generationConfig = isi.generationConfig || {};
      if (!tanpaBerpikir) {
        isi.generationConfig.thinkingConfig = { thinkingLevel: "low" };
      }

      let r, data;
      try {
        r = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(isi),
            signal: AbortSignal.timeout(Math.min(sisa, WAKTU_PER_PERCOBAAN_MS)),
          }
        );
        data = await r.json();
      } catch (e) {
        gagal.push(model + ": " + (e.name === "TimeoutError" ? "lambat" : e.message));
        break; // lambat atau error jaringan: pindah ke model berikutnya
      }
      if (r.ok) return { ok: true, model, data, gagal };

      gagal.push(model + ": " + r.status);
      const pesan = (data && data.error && data.error.message) || "";

      // Model menolak pengaturan berpikir: ulangi tanpa pengaturan itu
      if (r.status === 400 && !tanpaBerpikir && /think/i.test(pesan)) {
        tanpaBerpikir = true;
        continue;
      }

      const bisaCobaLagi = [404, 429, 500, 503, 504].includes(r.status);
      if (!bisaCobaLagi) return { ok: false, status: r.status, pesan, gagal };
      if (r.status === 404) break;
      if (percobaan >= 1) break;
      await sleep(1000);
    }
  }
  return {
    ok: false,
    status: 503,
    pesan: "Semua model Gemini sedang sibuk atau lambat. Coba lagi dalam beberapa menit.",
    gagal,
  };
}

const schema = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING" },
          level: { type: "STRING" },
          topic: { type: "STRING" },
          question: { type: "STRING" },
          options: { type: "ARRAY", items: { type: "STRING" } },
          answer: { type: "STRING" },
          explanation: { type: "STRING" },
          indicator: { type: "STRING" },
        },
        required: ["type", "level", "question", "options", "answer"],
      },
    },
  },
  required: ["questions"],
};

function buatPrompt(d, jumlah, bagian, totalBagian) {
  const catatanBagian =
    totalBagian > 1
      ? `\nIni bagian ${bagian} dari ${totalBagian} dari satu paket soal. Pilih subtopik berbeda dari bagian lain dan jangan membuat soal yang sama atau mirip.`
      : "";
  return `Kamu adalah guru SD berpengalaman di Indonesia yang ahli menyusun soal sesuai Kurikulum Merdeka.
Buatkan TEPAT ${jumlah} soal dengan ketentuan berikut:
- Mata pelajaran: ${d.subject}
- Kelas: ${d.grade} SD
- Jenis asesmen: ${d.assessment}
- Materi / CP / TP: ${d.material}
- Bentuk soal yang dipakai (bagi rata): ${d.types.join(", ")}
- Level kognitif yang dipakai (bagi rata): ${d.levels.join(", ")}
- Ketentuan tambahan: ${d.notes || "tidak ada"}${catatanBagian}

Aturan:
1. Bahasa Indonesia yang sesuai usia siswa kelas ${d.grade}. Gunakan konteks kehidupan sehari-hari.
2. Isi field "type" persis salah satu dari: ${d.types.join(" | ")}.
3. Isi field "level" persis salah satu dari: ${d.levels.join(" | ")}.
4. Pilihan ganda: "options" berisi 4 teks pilihan TANPA awalan huruf (A., B., dst), "answer" berupa satu huruf (A/B/C/D).
5. Pilihan ganda kompleks: "options" 4-5 teks, "answer" berisi huruf-huruf benar, contoh "A dan C".
6. Benar atau salah: "options" berisi ["Benar","Salah"], "answer" berisi "Benar" atau "Salah".
7. Menjodohkan: tulis pasangan di dalam teks "question", "options" kosong, "answer" berisi pasangan yang benar.
8. Isian singkat dan Uraian: "options" array kosong, "answer" berisi jawaban/pedoman penilaian.
9. "explanation" berisi pembahasan singkat, "indicator" berisi indikator soal, "topic" berisi subtopik materi.
10. Soal harus akurat secara fakta dan kunci jawabannya benar.`;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    const info = {
      status: "backend hidup",
      versi: "v7-cepat",
      daftarModel: MODELS,
      apiKeyTerbaca: Boolean(process.env.GEMINI_API_KEY),
    };
    if (req.query && req.query.tes && process.env.GEMINI_API_KEY) {
      const t0 = Date.now();
      const h = await callGemini(
        process.env.GEMINI_API_KEY,
        { contents: [{ parts: [{ text: "Balas satu kata saja: halo" }] }] },
        t0
      );
      info.hasilTesGemini = h.ok
        ? { berhasil: true, modelDipakai: h.model, durasiMs: Date.now() - t0, percobaanGagal: h.gagal }
        : { berhasil: false, status: h.status, pesan: h.pesan, durasiMs: Date.now() - t0, percobaanGagal: h.gagal };
    }
    return res.status(200).json(info);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Gunakan metode POST" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY belum diatur di Vercel" });
  }

  const b = req.body || {};
  const d = {
    subject: b.subject || "",
    grade: b.grade || "",
    material: b.material || "",
    assessment: b.assessment || "",
    notes: b.notes || "",
    types: Array.isArray(b.types) && b.types.length ? b.types : ["Pilihan ganda"],
    levels: Array.isArray(b.levels) && b.levels.length ? b.levels : ["C1", "C2"],
  };
  const count = Math.min(Number(b.count) || 10, 50);

  if (!d.subject || !d.material) {
    return res.status(400).json({ error: "Mata pelajaran dan materi wajib diisi" });
  }

  const totalBagian = Math.ceil(count / UKURAN_BAGIAN);
  const jumlahTiapBagian = [];
  let sisaSoal = count;
  for (let i = 0; i < totalBagian; i++) {
    const n = Math.min(UKURAN_BAGIAN, sisaSoal);
    jumlahTiapBagian.push(n);
    sisaSoal -= n;
  }

  const mulai = Date.now();
  try {
    const hasil = await Promise.all(
      jumlahTiapBagian.map((n, i) =>
        callGemini(
          apiKey,
          {
            contents: [{ parts: [{ text: buatPrompt(d, n, i + 1, totalBagian) }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: schema,
            },
          },
          mulai
        )
      )
    );

    const semuaSoal = [];
    let galatPertama = null;
    for (const h of hasil) {
      if (!h.ok) {
        if (!galatPertama) galatPertama = h;
        continue;
      }
      try {
        const text = h.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.questions)) semuaSoal.push(...parsed.questions);
      } catch (e) {
        // bagian ini diabaikan, bagian lain tetap dipakai
      }
    }

    if (!semuaSoal.length) {
      const pesan = galatPertama
        ? "Gemini membalas " + galatPertama.status + ": " + (galatPertama.pesan || "Gagal memanggil Gemini") +
          " (" + galatPertama.gagal.join(", ") + ")"
        : "AI tidak menghasilkan soal, coba lagi";
      return res.status(502).json({ error: pesan });
    }
    return res.status(200).json({ questions: semuaSoal.slice(0, count) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

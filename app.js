// ============================================================================
// CONFIGURAÇÃO DO SUPABASE — PROJECT URL & PUBLISHABLE KEY
// ============================================================================
const SUPABASE_URL = "https://ixjboxwderwkpplznaaa.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_54UEzsED6kb-T-f-fa6tlQ_YfN1064-";

const NUMERO_MPESA_ADMIN = "846759324";
const NUMERO_EMOLA_ADMIN = "875096046";
const VALOR_RENOVACAO_MT = 100;
// ============================================================================

let supabaseClient = null;
try {
  const urlLimpa = String(SUPABASE_URL || "").trim();
  const chaveLimpa = String(SUPABASE_ANON_KEY || "").trim();
  const urlValida = /^https?:\/\/.+/i.test(urlLimpa) && !urlLimpa.includes("COLA_AQUI");
  const chaveValida = chaveLimpa.length > 10 && !chaveLimpa.includes("COLA_AQUI");

  if (window.supabase && typeof window.supabase.createClient === "function" && urlValida && chaveValida) {
    supabaseClient = window.supabase.createClient(urlLimpa, chaveLimpa);
  }
} catch (err) {
  console.warn("Supabase não inicializado:", err.message);
  supabaseClient = null;
}

// 1. INICIALIZAR A BASE DE DADOS OFFLINE (IndexedDB via Dexie)
const db = new Dexie("GymControlOfflineDB");

db.version(2).stores({
  config: "id",
  alunos: "++id, uid, gymId, nome, telefone, plano, dataExpiracao, sincronizado",
  pagamentos: "++id, uid, gymId, alunoUid, alunoId, dataHora, valor, metodo, sincronizado",
  checkins: "++id, uid, gymId, alunoUid, alunoId, alunoNome, plano, dataHora, sincronizado"
}).upgrade(async (tx) => {
  const cfg = await tx.table("config").get("academia_principal");
  const gymId = cfg?.gymId || "";

  await tx.table("alunos").toCollection().modify((a) => {
    if (!a.uid) a.uid = crypto.randomUUID ? crypto.randomUUID() : `al-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!a.gymId && gymId) a.gymId = gymId;
    if (a.sincronizado === undefined) a.sincronizado = 0;
  });

  await tx.table("pagamentos").toCollection().modify((p) => {
    if (!p.uid) p.uid = crypto.randomUUID ? crypto.randomUUID() : `pg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!p.gymId && gymId) p.gymId = gymId;
    if (!p.dataHora && p.data) p.dataHora = typeof p.data === "number" ? p.data : new Date(p.data).getTime();
    if (p.sincronizado === undefined) p.sincronizado = 0;
  });

  await tx.table("checkins").toCollection().modify((c) => {
    if (!c.uid) c.uid = crypto.randomUUID ? crypto.randomUUID() : `ch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!c.gymId && gymId) c.gymId = gymId;
    if (!c.dataHora && c.data_hora) c.dataHora = typeof c.data_hora === "number" ? c.data_hora : new Date(c.data_hora).getTime();
    if (c.sincronizado === undefined) c.sincronizado = 0;
  });
});

const SEGREDO_MESTRE = "GYM_MOZ_2026_SECRETO";
const CHAVE_SESSAO_LOCAL = "gymcontrol_sessao_autenticada";
let filtroAtualAlunos = "todos";

function gerarUidUnico(prefixo = "item") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${prefixo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function gerarHashSenha(senha) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${senha}|${SEGREDO_MESTRE}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizarTelefone(valor) {
  return String(valor || "").trim().toLowerCase().replace(/\s+/g, "");
}

function alternarAbaAuth(aba) {
  const formLogin = document.getElementById("form-login");
  const formSignup = document.getElementById("form-academia");
  const btnLogin = document.getElementById("btn-auth-login");
  const btnSignup = document.getElementById("btn-auth-signup");
  const msgErro = document.getElementById("msg-erro-auth");

  if (msgErro) msgErro.classList.add("hidden");
  if (!formLogin || !formSignup || !btnLogin || !btnSignup) return;

  if (aba === "login") {
    formLogin.classList.remove("hidden");
    formSignup.classList.add("hidden");
    btnLogin.className = "py-2.5 rounded-xl text-xs font-extrabold transition bg-teal-400 text-slate-950 shadow";
    btnSignup.className = "py-2.5 rounded-xl text-xs font-bold transition text-slate-400 hover:text-white";
  } else {
    formLogin.classList.add("hidden");
    formSignup.classList.remove("hidden");
    btnSignup.className = "py-2.5 rounded-xl text-xs font-extrabold transition bg-teal-400 text-slate-950 shadow";
    btnLogin.className = "py-2.5 rounded-xl text-xs font-bold transition text-slate-400 hover:text-white";
  }
}

function exibirErroAuth(msg) {
  const el = document.getElementById("msg-erro-auth");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
}

function alternarFormAluno(forcarEstado) {
  const box = document.getElementById("box-cadastro-aluno");
  const btn = document.getElementById("btn-abrir-form-aluno");
  if (!box) return;

  const deveAbrir = typeof forcarEstado === "boolean"
    ? forcarEstado
    : box.classList.contains("hidden");

  if (deveAbrir) {
    box.classList.remove("hidden");
    if (btn) btn.textContent = "−";
    const inputNome = document.getElementById("aluno-nome");
    if (inputNome) inputNome.focus();
  } else {
    box.classList.add("hidden");
    if (btn) btn.textContent = "+";
  }
}

// ============================================================================
// SINCRONIZAÇÃO BIDIRECIONAL SUPABASE <-> DEXIE (POR gym_id)
// ============================================================================
function calcularEstadoAluno(dataExpiracao) {
  const agora = Date.now();
  const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;
  if (dataExpiracao < agora) return "expirado";
  if (dataExpiracao <= agora + tresDiasEmMs) return "expira_em_breve";
  return "ativo";
}

function formatarDataIso(timestampMs) {
  const d = new Date(timestampMs || Date.now());
  return d.toISOString().slice(0, 10);
}

async function enviarAlunoParaNuvem(aluno) {
  if (!supabaseClient || !navigator.onLine || !aluno?.gymId) return false;
  const uid = aluno.uid || gerarUidUnico("aluno");
  const payload = {
    id: uid,
    gym_id: aluno.gymId,
    nome: aluno.nome,
    telefone: aluno.telefone || "",
    plano: aluno.plano || "mensal",
    validade: formatarDataIso(aluno.dataExpiracao),
    estado: calcularEstadoAluno(aluno.dataExpiracao),
    atualizado_em: new Date().toISOString()
  };

  const { error } = await supabaseClient
    .from("alunos")
    .upsert(payload, { onConflict: "id" });

  if (error) {
    console.warn("Erro ao sincronizar aluno na nuvem:", error.message);
    return false;
  }

  if (aluno.id) {
    await db.alunos.update(aluno.id, { uid, sincronizado: 1 });
  }
  return true;
}

async function enviarPagamentoParaNuvem(pagamento, alunoUid = null) {
  if (!supabaseClient || !navigator.onLine || !pagamento?.gymId) return false;
  const uid = pagamento.uid || gerarUidUnico("pag");
  const payload = {
    id: uid,
    gym_id: pagamento.gymId,
    aluno_id: alunoUid || pagamento.alunoUid || null,
    valor: Number(pagamento.valor || 0),
    data_pagamento: new Date(pagamento.dataHora || Date.now()).toISOString(),
    metodo: pagamento.metodo || "Dinheiro",
    atualizado_em: new Date().toISOString()
  };

  const { error } = await supabaseClient
    .from("pagamentos")
    .upsert(payload, { onConflict: "id" });

  if (error) {
    console.warn("Erro ao sincronizar pagamento na nuvem:", error.message);
    return false;
  }

  if (pagamento.id) {
    await db.pagamentos.update(pagamento.id, { uid, sincronizado: 1 });
  }
  return true;
}

async function enviarCheckinParaNuvem(checkin, alunoUid = null) {
  if (!supabaseClient || !navigator.onLine || !checkin?.gymId) return false;
  const uid = checkin.uid || gerarUidUnico("chk");
  const payload = {
    id: uid,
    gym_id: checkin.gymId,
    aluno_id: alunoUid || checkin.alunoUid || null,
    nome_aluno: checkin.alunoNome || "Aluno",
    plano: checkin.plano || null,
    data_hora: new Date(checkin.dataHora || Date.now()).toISOString(),
    atualizado_em: new Date().toISOString()
  };

  const { error } = await supabaseClient
    .from("treinos")
    .upsert(payload, { onConflict: "id" });

  if (error) {
    console.warn("Erro ao sincronizar treino na nuvem:", error.message);
    return false;
  }

  if (checkin.id) {
    await db.checkins.update(checkin.id, { uid, sincronizado: 1 });
  }
  return true;
}

async function sincronizarPendentesNuvem(gymId) {
  if (!supabaseClient || !navigator.onLine || !gymId) return;

  const alunosPendentes = await db.alunos
    .filter(a => a.gymId === gymId && a.sincronizado !== 1)
    .toArray();
  for (const aluno of alunosPendentes) {
    await enviarAlunoParaNuvem(aluno);
  }

  const pagamentosPendentes = await db.pagamentos
    .filter(p => p.gymId === gymId && p.sincronizado !== 1)
    .toArray();
  for (const pag of pagamentosPendentes) {
    await enviarPagamentoParaNuvem(pag);
  }

  const checkinsPendentes = await db.checkins
    .filter(c => c.gymId === gymId && c.sincronizado !== 1)
    .toArray();
  for (const chk of checkinsPendentes) {
    await enviarCheckinParaNuvem(chk);
  }
}

async function puxarDadosContaDaNuvem(gymId) {
  if (!supabaseClient || !navigator.onLine || !gymId) return;

  await sincronizarPendentesNuvem(gymId);

  const [resAlunos, resPagamentos, resTreinos] = await Promise.all([
    supabaseClient.from("alunos").select("*").eq("gym_id", gymId),
    supabaseClient.from("pagamentos").select("*").eq("gym_id", gymId),
    supabaseClient.from("treinos").select("*").eq("gym_id", gymId)
  ]);

  const mapaAlunoUidParaLocalId = new Map();

  if (!resAlunos.error && Array.isArray(resAlunos.data)) {
    const locaisAlunos = await db.alunos.filter(a => a.gymId === gymId).toArray();
    const porUid = new Map(locaisAlunos.filter(a => a.uid).map(a => [a.uid, a]));

    for (const rem of resAlunos.data) {
      const expiraMs = rem.validade
        ? new Date(`${String(rem.validade).slice(0, 10)}T23:59:59`).getTime()
        : Date.now();
      const criadoMs = rem.criado_em ? new Date(rem.criado_em).getTime() : Date.now();

      const existente = porUid.get(rem.id);
      if (existente) {
        await db.alunos.update(existente.id, {
          uid: rem.id,
          gymId,
          nome: rem.nome,
          telefone: rem.telefone || "",
          plano: rem.plano || "mensal",
          dataExpiracao: expiraMs,
          sincronizado: 1
        });
        mapaAlunoUidParaLocalId.set(rem.id, existente.id);
      } else {
        const novoId = await db.alunos.add({
          uid: rem.id,
          gymId,
          nome: rem.nome,
          telefone: rem.telefone || "",
          plano: rem.plano || "mensal",
          dataCadastro: criadoMs,
          dataExpiracao: expiraMs,
          sincronizado: 1
        });
        mapaAlunoUidParaLocalId.set(rem.id, novoId);
      }
    }
  }

  const todosAlunosGym = await db.alunos.filter(a => a.gymId === gymId).toArray();
  const mapaNomeAluno = new Map(todosAlunosGym.map(a => [a.uid, a]));

  if (!resPagamentos.error && Array.isArray(resPagamentos.data)) {
    const locaisPag = await db.pagamentos.filter(p => p.gymId === gymId).toArray();
    const porUid = new Map(locaisPag.filter(p => p.uid).map(p => [p.uid, p]));

    for (const rem of resPagamentos.data) {
      const dataMs = rem.data_pagamento ? new Date(rem.data_pagamento).getTime() : Date.now();
      const alunoRef = rem.aluno_id ? mapaNomeAluno.get(rem.aluno_id) : null;
      const alunoLocalId = rem.aluno_id ? (mapaAlunoUidParaLocalId.get(rem.aluno_id) || null) : null;

      const existente = porUid.get(rem.id);
      if (existente) {
        await db.pagamentos.update(existente.id, {
          uid: rem.id,
          gymId,
          alunoUid: rem.aluno_id || null,
          alunoId: alunoLocalId,
          alunoNome: alunoRef?.nome || existente.alunoNome || "Aluno",
          plano: alunoRef?.plano || existente.plano || "mensal",
          valor: Number(rem.valor || 0),
          metodo: rem.metodo || "Dinheiro",
          dataHora: dataMs,
          sincronizado: 1
        });
      } else {
        await db.pagamentos.add({
          uid: rem.id,
          gymId,
          alunoUid: rem.aluno_id || null,
          alunoId: alunoLocalId,
          alunoNome: alunoRef?.nome || "Aluno",
          plano: alunoRef?.plano || "mensal",
          valor: Number(rem.valor || 0),
          metodo: rem.metodo || "Dinheiro",
          dataHora: dataMs,
          sincronizado: 1
        });
      }
    }
  }

  if (!resTreinos.error && Array.isArray(resTreinos.data)) {
    const locaisChk = await db.checkins.filter(c => c.gymId === gymId).toArray();
    const porUid = new Map(locaisChk.filter(c => c.uid).map(c => [c.uid, c]));

    for (const rem of resTreinos.data) {
      const dataMs = rem.data_hora ? new Date(rem.data_hora).getTime() : Date.now();
      const alunoLocalId = rem.aluno_id ? (mapaAlunoUidParaLocalId.get(rem.aluno_id) || null) : null;

      const existente = porUid.get(rem.id);
      if (existente) {
        await db.checkins.update(existente.id, {
          uid: rem.id,
          gymId,
          alunoUid: rem.aluno_id || null,
          alunoId: alunoLocalId,
          alunoNome: rem.nome_aluno || existente.alunoNome || "Aluno",
          plano: rem.plano || existente.plano || null,
          dataHora: dataMs,
          sincronizado: 1
        });
      } else {
        await db.checkins.add({
          uid: rem.id,
          gymId,
          alunoUid: rem.aluno_id || null,
          alunoId: alunoLocalId,
          alunoNome: rem.nome_aluno || "Aluno",
          plano: rem.plano || null,
          dataHora: dataMs,
          sincronizado: 1
        });
      }
    }
  }
}

window.addEventListener("online", async () => {
  const academia = await db.config.get("academia_principal");
  if (academia?.gymId) {
    await sincronizarLicencaNuvem(academia);
    await puxarDadosContaDaNuvem(academia.gymId);
    if (typeof atualizarTudo === "function") {
      await atualizarTudo();
    }
  }
});

// Sincroniza a licença da academia a partir da nuvem (Supabase) quando online
async function sincronizarLicencaNuvem(academiaLocal) {
  if (!supabaseClient || !navigator.onLine) return academiaLocal;

  const { data, error } = await supabaseClient
    .from("academias")
    .select("gym_id, nome_academia, responsavel, telefone, licenca_expira_em")
    .eq("gym_id", academiaLocal.gymId)
    .maybeSingle();

  if (error || !data) return academiaLocal;

  const expiraMs = new Date(data.licenca_expira_em).getTime();
  const atualizada = {
    ...academiaLocal,
    nome: data.nome_academia,
    responsavel: data.responsavel,
    licencaExpiraEm: expiraMs
  };

  await db.config.put(atualizada);
  return atualizada;
}

// 2. FUNÇÃO PRINCIPAL QUE ARRANCA QUANDO O APP ABRE
async function iniciarApp() {
  try {
    const elMpesa = document.getElementById("info-mpesa");
    const elEmola = document.getElementById("info-emola");
    if (elMpesa) elMpesa.textContent = NUMERO_MPESA_ADMIN;
    if (elEmola) elEmola.textContent = NUMERO_EMOLA_ADMIN;

    let academia = await db.config.get("academia_principal");

    if (!academia) {
      mostrarTela("tela-cadastro-academia");
      alternarAbaAuth("signup");
      return;
    }

    const sessaoAtiva = localStorage.getItem(CHAVE_SESSAO_LOCAL);
    if (sessaoAtiva !== academia.gymId) {
      mostrarTela("tela-cadastro-academia");
      alternarAbaAuth("login");
      const inputLogin = document.getElementById("login-identificador");
      if (inputLogin && academia.telefone) inputLogin.value = academia.telefone;
      return;
    }

    academia = await sincronizarLicencaNuvem(academia);
    await puxarDadosContaDaNuvem(academia.gymId);

    const agora = Date.now();
    if (academia.ultimoAcesso && agora < academia.ultimoAcesso) {
      alert("Erro de data/hora detetado no dispositivo! Por favor, acerta o relógio do aparelho.");
      mostrarBloqueio(academia);
      return;
    }

    await db.config.update("academia_principal", { ultimoAcesso: agora });

    const msPorDia = 1000 * 60 * 60 * 24;
    const diasRestantes = Math.ceil((academia.licencaExpiraEm - agora) / msPorDia);

    if (diasRestantes <= 0) {
      mostrarBloqueio(academia);
    } else {
      abrirPainelPrincipal(academia, diasRestantes);
    }
  } catch (err) {
    console.error("Erro ao iniciar GymControl:", err);
    mostrarTela("tela-cadastro-academia");
    alternarAbaAuth("signup");
  }
}

// 3A. LOGIN (Verifica na nuvem se disponível, restaura dados da conta e guarda sessão local)
document.getElementById("form-login")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const identificadorDigitado = normalizarTelefone(document.getElementById("login-identificador").value);
  const senhaDigitada = document.getElementById("login-senha").value;
  const senhaHashDigitada = await gerarHashSenha(senhaDigitada);

  if (supabaseClient && navigator.onLine) {
    const { data: contaRemota, error } = await supabaseClient
      .from("academias")
      .select("*")
      .eq("telefone", identificadorDigitado)
      .maybeSingle();

    if (error) {
      exibirErroAuth("Erro ao comunicar com o servidor. Tenta novamente.");
      return;
    }

    if (!contaRemota) {
      exibirErroAuth("Conta não encontrada. Cria uma conta na aba Sign Up.");
      return;
    }

    if (contaRemota.senha_hash !== senhaHashDigitada) {
      exibirErroAuth("Palavra-passe incorreta.");
      return;
    }

    const localAtual = await db.config.get("academia_principal");
    const trocouDeConta = localAtual && localAtual.gymId && localAtual.gymId !== contaRemota.gym_id;
    const agora = Date.now();

    const registroLocal = {
      id: "academia_principal",
      gymId: contaRemota.gym_id,
      nome: contaRemota.nome_academia,
      responsavel: contaRemota.responsavel,
      telefone: contaRemota.telefone,
      senhaHash: contaRemota.senha_hash,
      criadoEm: trocouDeConta
        ? new Date(contaRemota.criado_em).getTime()
        : (localAtual?.criadoEm || new Date(contaRemota.criado_em).getTime()),
      ultimoAcesso: agora,
      licencaExpiraEm: new Date(contaRemota.licenca_expira_em).getTime(),
      chavesUsadas: trocouDeConta ? [] : (localAtual?.chavesUsadas || []),
      precos: trocouDeConta
        ? { diario: 100, semanal: 500, mensal: 1500 }
        : (localAtual?.precos || { diario: 100, semanal: 500, mensal: 1500 })
    };

    await db.config.put(registroLocal);
    localStorage.setItem(CHAVE_SESSAO_LOCAL, contaRemota.gym_id);
    await puxarDadosContaDaNuvem(contaRemota.gym_id);

    document.getElementById("form-login").reset();
    iniciarApp();
    return;
  }

  // Fallback offline
  const academia = await db.config.get("academia_principal");
  if (!academia) {
    exibirErroAuth("Sem ligação à internet e nenhuma conta local encontrada.");
    return;
  }

  if (normalizarTelefone(academia.telefone) !== identificadorDigitado) {
    exibirErroAuth("Telefone ou email não corresponde à conta registada.");
    return;
  }

  if (academia.senhaHash && academia.senhaHash !== senhaHashDigitada) {
    exibirErroAuth("Palavra-passe incorreta.");
    return;
  }

  localStorage.setItem(CHAVE_SESSAO_LOCAL, academia.gymId);
  document.getElementById("form-login").reset();
  iniciarApp();
});

// 3B. SIGN UP (Anti-burla: bloqueia 2.º trial gratuito para o mesmo telefone na nuvem)
document.getElementById("form-academia")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const nome = document.getElementById("gym-nome").value.trim();
  const responsavel = document.getElementById("gym-responsavel").value.trim();
  const telefoneNormalizado = normalizarTelefone(document.getElementById("gym-telefone").value);
  const senha = document.getElementById("gym-senha").value;
  const senhaHash = await gerarHashSenha(senha);

  if (supabaseClient && navigator.onLine) {
    const { data: trialExistente, error: erroTrial } = await supabaseClient
      .from("historico_trials")
      .select("telefone")
      .eq("telefone", telefoneNormalizado)
      .maybeSingle();

    if (erroTrial) {
      exibirErroAuth("Erro ao verificar histórico de teste na nuvem.");
      return;
    }

    if (trialExistente) {
      exibirErroAuth(`Este número já utilizou o mês gratuito de teste. Faz login ou envia ${VALOR_RENOVACAO_MT} MT para renovar.`);
      return;
    }

    const idUnico = "GYM-" + Math.floor(1000 + Math.random() * 9000);
    const agora = Date.now();
    const trintaDiasEmMs = 30 * 24 * 60 * 60 * 1000;
    const expiraEmIso = new Date(agora + trintaDiasEmMs).toISOString();

    const { error: erroInsertAcademia } = await supabaseClient
      .from("academias")
      .insert({
        gym_id: idUnico,
        nome_academia: nome,
        responsavel: responsavel,
        telefone: telefoneNormalizado,
        senha_hash: senhaHash,
        licenca_expira_em: expiraEmIso
      });

    if (erroInsertAcademia) {
      exibirErroAuth("Este telefone já está registado. Faz login com a tua palavra-passe.");
      return;
    }

    await supabaseClient
      .from("historico_trials")
      .insert({
        telefone: telefoneNormalizado,
        gym_id: idUnico
      });

    await db.config.put({
      id: "academia_principal",
      gymId: idUnico,
      nome,
      responsavel,
      telefone: telefoneNormalizado,
      senhaHash,
      criadoEm: agora,
      ultimoAcesso: agora,
      licencaExpiraEm: agora + trintaDiasEmMs,
      chavesUsadas: [],
      precos: { diario: 100, semanal: 500, mensal: 1500 }
    });

    localStorage.setItem(CHAVE_SESSAO_LOCAL, idUnico);
    document.getElementById("form-academia").reset();
    iniciarApp();
    return;
  }

  // Fallback local caso não haja chaves configuradas ou esteja offline na 1.ª abertura
  const existente = await db.config.get("academia_principal");
  if (existente) {
    exibirErroAuth("Já existe uma academia registada neste aparelho. Faz login.");
    alternarAbaAuth("login");
    return;
  }

  const idUnico = "GYM-" + Math.floor(1000 + Math.random() * 9000);
  const agora = Date.now();
  const trintaDiasEmMs = 30 * 24 * 60 * 60 * 1000;

  await db.config.put({
    id: "academia_principal",
    gymId: idUnico,
    nome,
    responsavel,
    telefone: telefoneNormalizado,
    senhaHash,
    criadoEm: agora,
    ultimoAcesso: agora,
    licencaExpiraEm: agora + trintaDiasEmMs,
    chavesUsadas: [],
    precos: { diario: 100, semanal: 500, mensal: 1500 }
  });

  localStorage.setItem(CHAVE_SESSAO_LOCAL, idUnico);
  document.getElementById("form-academia").reset();
  iniciarApp();
});

// Termina apenas a sessão ativa sem apagar alunos, pagamentos ou check-ins guardados
function terminarSessao() {
  localStorage.removeItem(CHAVE_SESSAO_LOCAL);
  if (typeof toggleMenuLateral === "function") toggleMenuLateral(false);
  iniciarApp();
}

// 4. PREÇOS DA ACADEMIA
document.getElementById("form-precos")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const diario = parseFloat(document.getElementById("preco-diario").value);
  const semanal = parseFloat(document.getElementById("preco-semanal").value);
  const mensal = parseFloat(document.getElementById("preco-mensal").value);

  await db.config.update("academia_principal", {
    precos: { diario, semanal, mensal }
  });

  const academia = await db.config.get("academia_principal");
  atualizarInterfacePrecos(academia);
  alert("Preços atualizados com sucesso!");
});

function atualizarInterfacePrecos(academia) {
  const precos = academia.precos || { diario: 100, semanal: 500, mensal: 1500 };
  document.getElementById("preco-diario").value = precos.diario;
  document.getElementById("preco-semanal").value = precos.semanal;
  document.getElementById("preco-mensal").value = precos.mensal;

  const selectPlano = document.getElementById("aluno-plano");
  if (selectPlano) {
    selectPlano.innerHTML = `
      <option value="diario">Diário (1 Dia) - ${precos.diario.toLocaleString("pt-MZ")} MT</option>
      <option value="semanal">Semanal (7 Dias) - ${precos.semanal.toLocaleString("pt-MZ")} MT</option>
      <option value="mensal" selected>Mensal (30 Dias) - ${precos.mensal.toLocaleString("pt-MZ")} MT</option>
    `;
  }
}

// 5. ATIVAÇÃO DE LICENÇA VIA CHAVE SHA-256 (+30 DIAS)
document.getElementById("form-ativar-licenca")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const codigoInput = document.getElementById("input-chave-licenca").value.trim().toUpperCase();
  const academia = await db.config.get("academia_principal");
  if (!academia) return;

  if (!codigoInput || !codigoInput.includes("-")) {
    exibirErroChave("Introduz uma chave válida no formato LOTE-CÓDIGO (ex: MES01-A1B2C3).");
    return;
  }

  const chaveOfflineValida = await verificarChaveOffline(academia.gymId, codigoInput);
  if (!chaveOfflineValida) {
    exibirErroChave("Chave inválida para este ID de ginásio. Confere o ID e tenta novamente.");
    return;
  }

  if (academia.chavesUsadas && academia.chavesUsadas.includes(codigoInput)) {
    exibirErroChave("Esta chave já foi utilizada anteriormente.");
    return;
  }

  const agora = Date.now();
  const mais30Dias = 30 * 24 * 60 * 60 * 1000;
  const novasChaves = [...(academia.chavesUsadas || []), codigoInput];

  await db.config.update("academia_principal", {
    licencaExpiraEm: agora + mais30Dias,
    ultimoAcesso: agora,
    chavesUsadas: novasChaves
  });

  if (supabaseClient && navigator.onLine) {
    await supabaseClient
      .from("academias")
      .update({ licenca_expira_em: new Date(agora + mais30Dias).toISOString() })
      .eq("gym_id", academia.gymId);
  }

  document.getElementById("form-ativar-licenca").reset();
  alert("Licença renovada com sucesso por mais 30 dias!");
  iniciarApp();
});

// 6. NOVO ALUNO & CAIXA (Grava local e sincroniza na nuvem)
document.getElementById("form-novo-aluno")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const nome = document.getElementById("aluno-nome").value.trim();
  const telefone = document.getElementById("aluno-telefone").value.trim();
  const plano = document.getElementById("aluno-plano").value;
  const metodoPagamento = document.getElementById("pagamento-metodo").value;

  const academia = await db.config.get("academia_principal");
  const gymId = academia?.gymId || "";
  const precos = academia?.precos || { diario: 100, semanal: 500, mensal: 1500 };

  let valorPago = precos.mensal;
  let diasAdicionais = 30;
  if (plano === "diario") { valorPago = precos.diario; diasAdicionais = 1; }
  else if (plano === "semanal") { valorPago = precos.semanal; diasAdicionais = 7; }

  const agora = Date.now();
  const msPorDia = 24 * 60 * 60 * 1000;
  const dataExpiracao = agora + (diasAdicionais * msPorDia);
  const alunoUid = gerarUidUnico("aluno");
  const pagamentoUid = gerarUidUnico("pag");

  const alunoId = await db.alunos.add({
    uid: alunoUid,
    gymId,
    nome,
    telefone,
    plano,
    dataCadastro: agora,
    dataExpiracao,
    sincronizado: 0
  });

  const pagamentoId = await db.pagamentos.add({
    uid: pagamentoUid,
    gymId,
    alunoUid,
    alunoId,
    alunoNome: nome,
    plano,
    valor: valorPago,
    metodo: metodoPagamento,
    dataHora: agora,
    sincronizado: 0
  });

  const alunoSalvo = await db.alunos.get(alunoId);
  const pagamentoSalvo = await db.pagamentos.get(pagamentoId);
  await enviarAlunoParaNuvem(alunoSalvo);
  await enviarPagamentoParaNuvem(pagamentoSalvo, alunoUid);

  document.getElementById("form-novo-aluno").reset();
  alternarFormAluno(false);
  atualizarTudo();
  alert(`Aluno ${nome} cadastrado com sucesso! Pagamento de ${valorPago.toLocaleString("pt-MZ")} MT registado.`);
});

// 7. CARREGAMENTO DE ESTATÍSTICAS, CAIXA E ALUNOS
async function atualizarTudo() {
  await carregarAlunosEstatisticasCaixa();
  await carregarCheckinsHoje();
  await carregarRelatoriosFinanceiros();
  await carregarHistoricoTreinos();
}

async function carregarAlunosEstatisticasCaixa() {
  const academia = await db.config.get("academia_principal");
  const gymIdAtual = academia?.gymId;

  const todosAlunos = await db.alunos.toArray();
  const todosPagamentos = await db.pagamentos.toArray();

  const alunos = gymIdAtual
    ? todosAlunos.filter(a => !a.gymId || a.gymId === gymIdAtual)
    : todosAlunos;
  const pagamentos = gymIdAtual
    ? todosPagamentos.filter(p => !p.gymId || p.gymId === gymIdAtual)
    : todosPagamentos;

  const corpoTabela = document.getElementById("tabela-alunos-corpo");
  if (!corpoTabela) return;

  corpoTabela.innerHTML = "";

  let totalExpiramEmBreve = 0;
  let totalCaixaHoje = 0;
  const totaisPorMetodo = { "Dinheiro": 0, "M-Pesa": 0, "e-Mola": 0, "POS": 0 };

  const agora = Date.now();
  const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;
  const hojeInicio = new Date().setHours(0, 0, 0, 0);

  const corpoPagamentos = document.getElementById("tabela-pagamentos-corpo");
  if (corpoPagamentos) corpoPagamentos.innerHTML = "";

  const pagamentosHoje = pagamentos
    .filter(p => p.dataHora >= hojeInicio)
    .sort((a, b) => b.dataHora - a.dataHora);

  pagamentosHoje.forEach(pag => {
    totalCaixaHoje += pag.valor;
    if (totaisPorMetodo[pag.metodo] !== undefined) totaisPorMetodo[pag.metodo] += pag.valor;

    if (corpoPagamentos) {
      const horaFormatada = new Date(pag.dataHora).toLocaleTimeString("pt-MZ", { hour: "2-digit", minute: "2-digit" });
      const trPag = document.createElement("tr");
      trPag.innerHTML = `
        <td class="p-3 text-slate-400 font-mono text-xs">${horaFormatada}</td>
        <td class="p-3 font-medium text-white">${pag.alunoNome || "Aluno"}</td>
        <td class="p-3 capitalize text-slate-300">${pag.plano}</td>
        <td class="p-3 text-slate-300">${pag.metodo}</td>
        <td class="p-3 text-right font-semibold text-teal-400">${pag.valor.toLocaleString("pt-MZ")} MT</td>
      `;
      corpoPagamentos.appendChild(trPag);
    }
  });

  if (corpoPagamentos && pagamentosHoje.length === 0) {
    corpoPagamentos.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-500">Nenhuma entrada registada hoje.</td></tr>`;
  }

  const boxResumoMetodos = document.getElementById("resumo-metodos-hoje");
  if (boxResumoMetodos) {
    boxResumoMetodos.innerHTML = Object.entries(totaisPorMetodo)
      .filter(([_, valor]) => valor > 0)
      .map(([metodo, valor]) => `<span class="bg-[#04090e] border border-slate-800 px-2.5 py-1 rounded-lg text-slate-300">${metodo}: <strong class="text-teal-400">${valor.toLocaleString("pt-MZ")} MT</strong></span>`)
      .join("");
  }

  const elemCaixa = document.querySelector("#aba-inicio .grid:nth-of-type(1) > div:nth-child(3) .text-3xl");
  if (elemCaixa) elemCaixa.textContent = `${totalCaixaHoje.toLocaleString("pt-MZ")} MT`;

  if (alunos.length === 0) {
    corpoTabela.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500">Nenhum aluno cadastrado ainda. Clica no botão + para registar.</td></tr>`;
    document.getElementById("stat-total-alunos").textContent = "0";
    document.getElementById("stat-expiram-breve").textContent = "0";
    return;
  }

  document.getElementById("stat-total-alunos").textContent = alunos.length;

  alunos.forEach(aluno => {
    const expirado = aluno.dataExpiracao < agora;
    const prestesAExpirar = !expirado && (aluno.dataExpiracao <= (agora + tresDiasEmMs));
    if (prestesAExpirar) totalExpiramEmBreve++;

    if (filtroAtualAlunos === "ativos" && (expirado || prestesAExpirar)) return;
    if (filtroAtualAlunos === "breve" && !prestesAExpirar) return;
    if (filtroAtualAlunos === "expirados" && !expirado) return;

    const dataFormatada = new Date(aluno.dataExpiracao).toLocaleDateString("pt-MZ");
    const badgeStatus = expirado
      ? `<span class="bg-rose-500/20 text-rose-400 text-xs px-2.5 py-1 rounded-full border border-rose-500/30 font-semibold">Expirado</span>`
      : prestesAExpirar
      ? `<span class="bg-amber-500/20 text-amber-300 text-xs px-2.5 py-1 rounded-full border border-amber-500/30 font-semibold">Expira em breve</span>`
      : `<span class="bg-teal-500/20 text-teal-300 text-xs px-2.5 py-1 rounded-full border border-teal-500/30">Ativo</span>`;

    const linha = document.createElement("tr");
    linha.innerHTML = `
      <td class="p-3 font-medium text-white">${aluno.nome}</td>
      <td class="p-3 text-slate-300">${aluno.telefone}</td>
      <td class="p-3 capitalize text-slate-300">${aluno.plano}</td>
      <td class="p-3 text-slate-300">${dataFormatada}</td>
      <td class="p-3">${badgeStatus}</td>
      <td class="p-3 text-right">
        <button onclick="abrirModalRenovacao(${aluno.id}, '${aluno.nome.replace(/'/g, "\\'")}')"
                class="bg-[#12222f] hover:bg-teal-400 hover:text-slate-950 text-slate-200 text-xs font-semibold px-3 py-1.5 rounded-xl transition">
          Renovar
        </button>
      </td>
    `;
    corpoTabela.appendChild(linha);
  });

  const elemExpiramBreve = document.getElementById("stat-expiram-breve");
  if (elemExpiramBreve) elemExpiramBreve.textContent = totalExpiramEmBreve;
}

function filtrarAlunos(tipo) {
  filtroAtualAlunos = tipo;
  ["todos", "ativos", "breve", "expirados"].forEach(t => {
    const btn = document.getElementById(`filtro-${t}`);
    if (btn) {
      btn.className = t === tipo
        ? "px-3.5 py-1.5 rounded-full bg-teal-400 text-slate-950 font-extrabold transition"
        : "px-3.5 py-1.5 rounded-full bg-[#04090e] border border-slate-800 text-slate-300 hover:bg-[#12222f] transition";
    }
  });
  carregarAlunosEstatisticasCaixa();
}

// 8. MODAL DE RENOVAÇÃO DE PLANO DO ALUNO
async function abrirModalRenovacao(alunoId, nomeAluno) {
  const academia = await db.config.get("academia_principal");
  const precos = academia?.precos || { diario: 100, semanal: 500, mensal: 1500 };
  document.getElementById("modal-aluno-id").value = alunoId;
  document.getElementById("modal-aluno-nome").textContent = `Aluno: ${nomeAluno}`;
  document.getElementById("modal-plano-select").innerHTML = `
    <option value="diario">Diário (+1 Dia) - ${precos.diario.toLocaleString("pt-MZ")} MT</option>
    <option value="semanal">Semanal (+7 Dias) - ${precos.semanal.toLocaleString("pt-MZ")} MT</option>
    <option value="mensal" selected>Mensal (+30 Dias) - ${precos.mensal.toLocaleString("pt-MZ")} MT</option>
  `;
  document.getElementById("modal-renovacao").classList.remove("hidden");
}

function fecharModalRenovacao() {
  document.getElementById("modal-renovacao").classList.add("hidden");
}

document.getElementById("form-renovar-aluno")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const alunoId = parseInt(document.getElementById("modal-aluno-id").value);
  const plano = document.getElementById("modal-plano-select").value;
  const metodo = document.getElementById("modal-metodo-select").value;

  const aluno = await db.alunos.get(alunoId);
  if (!aluno) return;

  const academia = await db.config.get("academia_principal");
  const gymId = aluno.gymId || academia?.gymId || "";
  const precos = academia?.precos || { diario: 100, semanal: 500, mensal: 1500 };

  let valorPago = precos.mensal;
  let diasAdicionais = 30;
  if (plano === "diario") { valorPago = precos.diario; diasAdicionais = 1; }
  if (plano === "semanal") { valorPago = precos.semanal; diasAdicionais = 7; }

  const agora = Date.now();
  const msPorDia = 24 * 60 * 60 * 1000;
  const baseCalculo = aluno.dataExpiracao > agora ? aluno.dataExpiracao : agora;
  const novaExpiracao = baseCalculo + (diasAdicionais * msPorDia);
  const alunoUid = aluno.uid || gerarUidUnico("aluno");
  const pagamentoUid = gerarUidUnico("pag");

  await db.alunos.update(alunoId, {
    uid: alunoUid,
    gymId,
    plano,
    dataExpiracao: novaExpiracao,
    sincronizado: 0
  });

  const pagamentoId = await db.pagamentos.add({
    uid: pagamentoUid,
    gymId,
    alunoUid,
    alunoId,
    alunoNome: aluno.nome,
    plano,
    valor: valorPago,
    metodo,
    dataHora: agora,
    sincronizado: 0
  });

  const alunoAtualizado = await db.alunos.get(alunoId);
  const pagamentoSalvo = await db.pagamentos.get(pagamentoId);
  await enviarAlunoParaNuvem(alunoAtualizado);
  await enviarPagamentoParaNuvem(pagamentoSalvo, alunoUid);

  fecharModalRenovacao();
  atualizarTudo();
  alert(`Plano renovado com sucesso para ${aluno.nome}! (+${valorPago.toLocaleString("pt-MZ")} MT no caixa)`);
});

// 9. VALIDAÇÃO DE CHAVE OFFLINE
async function verificarChaveOffline(gymId, chave) {
  const partes = chave.split("-");
  if (partes.length !== 2) return false;
  const [lote, assinaturaRecebida] = partes;
  const textoParaAssinar = `${gymId}|${lote}|${SEGREDO_MESTRE}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(textoParaAssinar);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return assinaturaRecebida === hashHex.substring(0, 6);
}

// 10. TELAS E BLOQUEIO
function mostrarTela(idTela) {
  ["tela-cadastro-academia", "tela-bloqueio", "painel-principal"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });
  const alvo = document.getElementById(idTela);
  if (alvo) alvo.classList.remove("hidden");
}

function mostrarBloqueio(academia) {
  const elGymId = document.getElementById("bloqueio-gym-id");
  if (elGymId) elGymId.textContent = academia.gymId;
  mostrarTela("tela-bloqueio");
}

function abrirPainelPrincipal(academia, diasRestantes) {
  document.getElementById("header-gym-nome").textContent = academia.nome;
  document.getElementById("header-gym-id").textContent = academia.gymId;

  const badge = document.getElementById("badge-dias-restantes");
  badge.textContent = `${diasRestantes} ${diasRestantes === 1 ? "dia restante" : "dias restantes"}`;
  badge.className = diasRestantes <= 5
    ? "bg-amber-500/15 text-amber-300 text-[11px] font-bold px-2.5 py-1 rounded-full border border-amber-500/30"
    : "bg-teal-500/15 text-teal-300 text-[11px] font-bold px-2.5 py-1 rounded-full border border-teal-500/30";

  mostrarTela("painel-principal");
  atualizarInterfacePrecos(academia);
  atualizarTudo();
}

function exibirErroChave(msg) {
  const el = document.getElementById("msg-erro-chave");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
}

async function simularExpiracao() {
  const academia = await db.config.get("academia_principal");
  if (!academia) return;

  const ontem = Date.now() - (24 * 60 * 60 * 1000);
  await db.config.update("academia_principal", { licencaExpiraEm: ontem });

  if (supabaseClient && navigator.onLine) {
    await supabaseClient
      .from("academias")
      .update({ licenca_expira_em: new Date(ontem).toISOString() })
      .eq("gym_id", academia.gymId);
  }

  if (typeof toggleMenuLateral === "function") toggleMenuLateral(false);
  mostrarBloqueio(academia);
}

// 11. CHECK-IN RÁPIDO
const inputPesquisa = document.getElementById("input-pesquisa-checkin");
const boxResultados = document.getElementById("resultados-checkin");

if (inputPesquisa) {
  inputPesquisa.addEventListener("input", async (e) => {
    const termo = e.target.value.trim().toLowerCase();
    if (!termo.length) {
      boxResultados?.classList.add("hidden");
      if (boxResultados) boxResultados.innerHTML = "";
      return;
    }

    const academia = await db.config.get("academia_principal");
    const gymIdAtual = academia?.gymId;
    const todosAlunos = await db.alunos.toArray();
    const alunos = gymIdAtual
      ? todosAlunos.filter(a => !a.gymId || a.gymId === gymIdAtual)
      : todosAlunos;

    const filtrados = alunos.filter(a => a.nome.toLowerCase().includes(termo));
    if (!boxResultados) return;
    boxResultados.innerHTML = "";

    if (!filtrados.length) {
      boxResultados.innerHTML = `<div class="p-3 text-sm text-slate-400 text-center">Nenhum aluno encontrado.</div>`;
      boxResultados.classList.remove("hidden");
      return;
    }

    filtrados.forEach(aluno => {
      const expirado = aluno.dataExpiracao < Date.now();
      const dataFormatada = new Date(aluno.dataExpiracao).toLocaleDateString("pt-MZ");
      const statusTexto = expirado ? "EXPIRADO" : "ATIVO";
      const corStatus = expirado ? "text-rose-400 bg-rose-500/10" : "text-teal-400 bg-teal-500/10";

      const item = document.createElement("div");
      item.className = "p-3 hover:bg-[#12222f] flex justify-between items-center cursor-pointer transition gap-2";
      item.innerHTML = `
        <div>
          <p class="font-medium text-white text-sm">${aluno.nome}</p>
          <p class="text-xs text-slate-400">Tel: ${aluno.telefone} • Expira: ${dataFormatada}</p>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <span class="text-xs px-2.5 py-1 rounded font-semibold ${corStatus}">${statusTexto}</span>
          <button onclick="realizarCheckin(${aluno.id}, '${aluno.nome.replace(/'/g, "\\'")}', ${expirado})"
                  class="bg-teal-400 hover:bg-teal-300 text-slate-950 font-bold px-3 py-1.5 rounded-xl text-xs transition">
            Fazer Check-in
          </button>
        </div>
      `;
      boxResultados.appendChild(item);
    });

    boxResultados.classList.remove("hidden");
  });
}

async function realizarCheckin(alunoId, nomeAluno, expirado) {
  if (expirado) {
    alert(`ATENÇÃO: A mensalidade de ${nomeAluno} está EXPIRADA!`);
    return;
  }

  const academia = await db.config.get("academia_principal");
  const aluno = await db.alunos.get(alunoId);
  const gymId = aluno?.gymId || academia?.gymId || "";
  const alunoUid = aluno?.uid || null;
  const agora = Date.now();
  const checkinUid = gerarUidUnico("chk");

  const checkinId = await db.checkins.add({
    uid: checkinUid,
    gymId,
    alunoUid,
    alunoId,
    alunoNome: nomeAluno,
    plano: aluno?.plano || null,
    dataHora: agora,
    sincronizado: 0
  });

  const checkinSalvo = await db.checkins.get(checkinId);
  await enviarCheckinParaNuvem(checkinSalvo, alunoUid);

  if (inputPesquisa) inputPesquisa.value = "";
  if (boxResultados) boxResultados.classList.add("hidden");
  alert(`Check-in registado com sucesso para ${nomeAluno}!`);
  await carregarCheckinsHoje();
  await carregarHistoricoTreinos();
}

async function carregarCheckinsHoje() {
  const academia = await db.config.get("academia_principal");
  const gymIdAtual = academia?.gymId;
  const todosCheckins = await db.checkins.toArray();
  const checkins = gymIdAtual
    ? todosCheckins.filter(c => !c.gymId || c.gymId === gymIdAtual)
    : todosCheckins;

  const corpoCheckins = document.getElementById("tabela-checkins-hoje");
  if (!corpoCheckins) return;
  corpoCheckins.innerHTML = "";

  const hojeInicio = new Date().setHours(0, 0, 0, 0);
  const checkinsHoje = checkins.filter(c => c.dataHora >= hojeInicio).sort((a, b) => b.dataHora - a.dataHora);

  if (!checkinsHoje.length) {
    corpoCheckins.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-slate-500">Nenhum check-in registado hoje.</td></tr>`;
    return;
  }

  checkinsHoje.forEach(chk => {
    const horaFormatada = new Date(chk.dataHora).toLocaleTimeString("pt-MZ", { hour: "2-digit", minute: "2-digit" });
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="p-3 text-slate-400 font-mono text-xs">${horaFormatada}</td>
      <td class="p-3 font-medium text-white">${chk.alunoNome || "Aluno"}</td>
      <td class="p-3 text-right"><span class="bg-teal-500/20 text-teal-300 text-xs px-2.5 py-1 rounded-full border border-teal-500/30">Entrada Autorizada</span></td>
    `;
    corpoCheckins.appendChild(tr);
  });
}

document.addEventListener("click", (e) => {
  if (inputPesquisa && boxResultados && !inputPesquisa.contains(e.target) && !boxResultados.contains(e.target)) {
    boxResultados.classList.add("hidden");
  }
});

// 12. BACKUP E RESTAURO JSON
async function exportarBackup() {
  try {
    const backupCompleto = {
      versao: "2.0",
      dataExportacao: new Date().toISOString(),
      config: await db.config.toArray(),
      alunos: await db.alunos.toArray(),
      pagamentos: await db.pagamentos.toArray(),
      checkins: await db.checkins.toArray()
    };
    const blob = new Blob([JSON.stringify(backupCompleto, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `backup-gymcontrol-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    alert("Cópia de segurança (Backup) descarregada com sucesso!");
  } catch (err) {
    console.error(err);
    alert("Erro ao gerar o ficheiro de backup.");
  }
}

async function importarBackup(event) {
  const ficheiro = event.target.files?.[0];
  if (!ficheiro) return;

  try {
    const texto = await ficheiro.text();
    const dados = JSON.parse(texto);
    const academiaAtual = await db.config.get("academia_principal");
    const gymIdAtual = dados.config?.[0]?.gymId || academiaAtual?.gymId || "";

    if (Array.isArray(dados.config) && dados.config.length > 0) {
      await db.config.bulkPut(dados.config);
    }

    if (Array.isArray(dados.alunos)) {
      for (const a of dados.alunos) {
        const uid = a.uid || gerarUidUnico("aluno");
        const registro = {
          uid,
          gymId: a.gymId || gymIdAtual,
          nome: a.nome,
          telefone: a.telefone || "",
          plano: a.plano || "mensal",
          dataCadastro: a.dataCadastro || Date.now(),
          dataExpiracao: a.dataExpiracao || Date.now(),
          sincronizado: 0
        };
        await db.alunos.add(registro);
        await enviarAlunoParaNuvem({ ...registro, uid });
      }
    }

    if (Array.isArray(dados.pagamentos)) {
      for (const p of dados.pagamentos) {
        const uid = p.uid || gerarUidUnico("pag");
        const registro = {
          uid,
          gymId: p.gymId || gymIdAtual,
          alunoUid: p.alunoUid || null,
          alunoId: p.alunoId || null,
          alunoNome: p.alunoNome || "Aluno",
          plano: p.plano || "mensal",
          valor: Number(p.valor || 0),
          metodo: p.metodo || "Dinheiro",
          dataHora: p.dataHora || Date.now(),
          sincronizado: 0
        };
        await db.pagamentos.add(registro);
        await enviarPagamentoParaNuvem(registro);
      }
    }

    if (Array.isArray(dados.checkins)) {
      for (const c of dados.checkins) {
        const uid = c.uid || gerarUidUnico("chk");
        const registro = {
          uid,
          gymId: c.gymId || gymIdAtual,
          alunoUid: c.alunoUid || null,
          alunoId: c.alunoId || null,
          alunoNome: c.alunoNome || "Aluno",
          plano: c.plano || null,
          dataHora: c.dataHora || Date.now(),
          sincronizado: 0
        };
        await db.checkins.add(registro);
        await enviarCheckinParaNuvem(registro);
      }
    }

    event.target.value = "";
    alert("Backup restaurado e sincronizado com sucesso!");
    await iniciarApp();
  } catch (err) {
    console.error("Erro ao importar backup:", err);
    alert("Ficheiro de backup inválido ou corrompido.");
  }
}

// 13. RELATÓRIOS FINANCEIROS & HISTÓRICO DE TREINOS
let periodoHistoricoTreinos = "diario";
let ultimosCheckinsFiltrados = [];

async function carregarRelatoriosFinanceiros() {
  const academia = await db.config.get("academia_principal");
  const gymIdAtual = academia?.gymId;
  const todosPagamentos = await db.pagamentos.toArray();

  const pagamentos = gymIdAtual
    ? todosPagamentos.filter(p => !p.gymId || p.gymId === gymIdAtual)
    : todosPagamentos;

  const agora = Date.now();
  const seteDiasAtras = agora - (7 * 24 * 60 * 60 * 1000);
  const dataAtual = new Date();
  const inicioMes = new Date(dataAtual.getFullYear(), dataAtual.getMonth(), 1).getTime();

  let totalSemana = 0;
  let totalMes = 0;

  pagamentos.forEach((pag) => {
    const ts = pag.dataHora || 0;
    const valor = Number(pag.valor || 0);
    if (ts >= seteDiasAtras) totalSemana += valor;
    if (ts >= inicioMes) totalMes += valor;
  });

  const elSemana = document.getElementById("relatorio-total-semana");
  const elMes = document.getElementById("relatorio-total-mes");
  if (elSemana) elSemana.textContent = `${totalSemana.toLocaleString("pt-MZ")} MT`;
  if (elMes) elMes.textContent = `${totalMes.toLocaleString("pt-MZ")} MT`;

  const corpoGeral = document.getElementById("tabela-historico-geral");
  if (!corpoGeral) return;
  corpoGeral.innerHTML = "";

  const ordenados = [...pagamentos].sort((a, b) => (b.dataHora || 0) - (a.dataHora || 0));
  if (!ordenados.length) {
    corpoGeral.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-500">Nenhum pagamento registado até ao momento.</td></tr>`;
    return;
  }

  ordenados.forEach((pag) => {
    const dataFmt = pag.dataHora
      ? new Date(pag.dataHora).toLocaleDateString("pt-MZ")
      : "---";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="p-3 text-slate-400 font-mono text-xs">${dataFmt}</td>
      <td class="p-3 font-medium text-white">${pag.alunoNome || "Aluno"}</td>
      <td class="p-3 capitalize text-slate-300">${pag.plano || "mensal"}</td>
      <td class="p-3 text-slate-300">${pag.metodo || "Dinheiro"}</td>
      <td class="p-3 text-right font-semibold text-teal-400">${Number(pag.valor || 0).toLocaleString("pt-MZ")} MT</td>
    `;
    corpoGeral.appendChild(tr);
  });
}

function filtrarHistoricoTreinos(periodo) {
  periodoHistoricoTreinos = periodo || "diario";
  const periodos = ["diario", "semanal", "mensal", "todos"];

  periodos.forEach((p) => {
    const btn = document.getElementById(`filtro-chk-${p}`);
    if (!btn) return;
    btn.className = p === periodoHistoricoTreinos
      ? "px-3.5 py-1.5 rounded-full bg-teal-400 text-slate-950 text-xs font-extrabold transition"
      : "px-3.5 py-1.5 rounded-full bg-[#04090e] border border-slate-800 text-slate-300 text-xs hover:bg-[#12222f] transition";
  });

  carregarHistoricoTreinos();
}

async function carregarHistoricoTreinos() {
  const academia = await db.config.get("academia_principal");
  const gymIdAtual = academia?.gymId;

  const [todosCheckins, todosAlunos] = await Promise.all([
    db.checkins.toArray(),
    db.alunos.toArray()
  ]);

  const checkins = gymIdAtual
    ? todosCheckins.filter(c => !c.gymId || c.gymId === gymIdAtual)
    : todosCheckins;

  const alunos = gymIdAtual
    ? todosAlunos.filter(a => !a.gymId || a.gymId === gymIdAtual)
    : todosAlunos;

  const mapaAlunosPorId = new Map(alunos.map(a => [a.id, a]));
  const mapaAlunosPorUid = new Map(alunos.filter(a => a.uid).map(a => [a.uid, a]));

  const agora = Date.now();
  const hojeInicio = new Date().setHours(0, 0, 0, 0);
  const seteDiasAtras = agora - (7 * 24 * 60 * 60 * 1000);
  const dataAtual = new Date();
  const inicioMes = new Date(dataAtual.getFullYear(), dataAtual.getMonth(), 1).getTime();

  let filtrados = checkins.filter((c) => {
    const ts = c.dataHora || 0;
    if (periodoHistoricoTreinos === "diario") return ts >= hojeInicio;
    if (periodoHistoricoTreinos === "semanal") return ts >= seteDiasAtras;
    if (periodoHistoricoTreinos === "mensal") return ts >= inicioMes;
    return true;
  });

  const termoBusca = (document.getElementById("input-busca-historico-treino")?.value || "")
    .trim()
    .toLowerCase();

  if (termoBusca) {
    filtrados = filtrados.filter(c => (c.alunoNome || "").toLowerCase().includes(termoBusca));
  }

  filtrados.sort((a, b) => (b.dataHora || 0) - (a.dataHora || 0));
  ultimosCheckinsFiltrados = filtrados;

  const totalTreinos = filtrados.length;
  const chavesAlunos = new Set();
  const contagemPorAluno = new Map();
  const contagemPorHora = new Map();
  const contagemPorPlano = { mensal: 0, semanal: 0, diario: 0 };
  const diasUnicos = new Set();

  filtrados.forEach((chk) => {
    const alunoRef = (chk.alunoUid && mapaAlunosPorUid.get(chk.alunoUid))
      || (chk.alunoId && mapaAlunosPorId.get(chk.alunoId))
      || null;

    const nomeAluno = chk.alunoNome || alunoRef?.nome || "Aluno";
    const chaveAluno = chk.alunoUid || chk.alunoId || nomeAluno.toLowerCase();
    chavesAlunos.add(chaveAluno);

    const atualCont = contagemPorAluno.get(chaveAluno) || { nome: nomeAluno, total: 0 };
    atualCont.total += 1;
    contagemPorAluno.set(chaveAluno, atualCont);

    const plano = (chk.plano || alunoRef?.plano || "mensal").toLowerCase();
    if (contagemPorPlano[plano] !== undefined) {
      contagemPorPlano[plano] += 1;
    }

    if (chk.dataHora) {
      const d = new Date(chk.dataHora);
      diasUnicos.add(d.toISOString().slice(0, 10));
      const hora = String(d.getHours()).padStart(2, "0");
      contagemPorHora.set(hora, (contagemPorHora.get(hora) || 0) + 1);
    }
  });

  const elTotalTreinos = document.getElementById("hist-total-treinos");
  const elAlunosUnicos = document.getElementById("hist-alunos-unicos");
  const elMediaDia = document.getElementById("hist-media-dia");
  const elHorarioPico = document.getElementById("hist-horario-pico");
  const elPicoQtd = document.getElementById("hist-pico-qtd");
  const elResumoPlanos = document.getElementById("hist-resumo-planos");

  if (elTotalTreinos) elTotalTreinos.textContent = String(totalTreinos);
  if (elAlunosUnicos) {
    elAlunosUnicos.textContent = `${chavesAlunos.size} ${chavesAlunos.size === 1 ? "aluno distinto" : "alunos distintos"}`;
  }

  let divisorDias = 1;
  if (periodoHistoricoTreinos === "semanal") divisorDias = 7;
  else if (periodoHistoricoTreinos === "mensal") divisorDias = Math.max(1, dataAtual.getDate());
  else if (periodoHistoricoTreinos === "todos") divisorDias = Math.max(1, diasUnicos.size);

  const mediaDia = totalTreinos > 0 ? (totalTreinos / divisorDias).toFixed(1).replace(".", ",") : "0";
  if (elMediaDia) elMediaDia.textContent = mediaDia;

  let melhorHora = "--:--";
  let maiorQtdHora = 0;
  contagemPorHora.forEach((qtd, hora) => {
    if (qtd > maiorQtdHora) {
      maiorQtdHora = qtd;
      melhorHora = `${hora}:00`;
    }
  });

  if (elHorarioPico) elHorarioPico.textContent = melhorHora;
  if (elPicoQtd) {
    elPicoQtd.textContent = maiorQtdHora > 0 ? `${maiorQtdHora} ${maiorQtdHora === 1 ? "entrada" : "entradas"}` : "maior movimento";
  }

  if (elResumoPlanos) {
    elResumoPlanos.innerHTML = `
      <p>Mensal: <strong class="text-teal-400">${contagemPorPlano.mensal}</strong></p>
      <p>Semanal: <strong class="text-white">${contagemPorPlano.semanal}</strong> • Diário: <strong class="text-white">${contagemPorPlano.diario}</strong></p>
    `;
  }

  const boxRanking = document.getElementById("hist-ranking-alunos");
  if (boxRanking) {
    const top3 = [...contagemPorAluno.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 3);

    if (!top3.length) {
      boxRanking.innerHTML = `<p class="text-slate-500">Sem registos neste período.</p>`;
    } else {
      const medalhas = ["🥇", "🥈", "🥉"];
      boxRanking.innerHTML = top3.map((item, idx) => `
        <div class="bg-[#04090e] border border-slate-800 rounded-xl p-3 flex items-center justify-between">
          <span class="font-semibold text-white truncate">${medalhas[idx] || "•"} ${item.nome}</span>
          <span class="text-teal-400 font-extrabold shrink-0 ml-2">${item.total} ${item.total === 1 ? "treino" : "treinos"}</span>
        </div>
      `).join("");
    }
  }

  const corpoTabela = document.getElementById("tabela-historico-treinos-corpo");
  if (!corpoTabela) return;
  corpoTabela.innerHTML = "";

  if (!filtrados.length) {
    corpoTabela.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-500">Nenhum registo de treino encontrado para este filtro.</td></tr>`;
    return;
  }

  filtrados.forEach((chk) => {
    const alunoRef = (chk.alunoUid && mapaAlunosPorUid.get(chk.alunoUid))
      || (chk.alunoId && mapaAlunosPorId.get(chk.alunoId))
      || null;

    const d = chk.dataHora ? new Date(chk.dataHora) : null;
    const dataFmt = d ? d.toLocaleDateString("pt-MZ") : "---";
    const horaFmt = d ? d.toLocaleTimeString("pt-MZ", { hour: "2-digit", minute: "2-digit" }) : "---";
    const nomeAluno = chk.alunoNome || alunoRef?.nome || "Aluno";
    const plano = chk.plano || alunoRef?.plano || "mensal";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="p-3 text-slate-400 font-mono text-xs">${dataFmt}</td>
      <td class="p-3 text-slate-400 font-mono text-xs">${horaFmt}</td>
      <td class="p-3 font-medium text-white">${nomeAluno}</td>
      <td class="p-3 capitalize text-slate-300">${plano}</td>
      <td class="p-3 text-right">
        <span class="bg-teal-500/20 text-teal-300 text-xs px-2.5 py-1 rounded-full border border-teal-500/30">Autorizado</span>
      </td>
    `;
    corpoTabela.appendChild(tr);
  });
}

function exportarHistoricoCheckinsCSV() {
  if (!ultimosCheckinsFiltrados.length) {
    alert("Não há registos de treinos no período selecionado para exportar.");
    return;
  }

  const linhas = ["Data;Hora;Aluno;Plano;Estado"];
  ultimosCheckinsFiltrados.forEach((chk) => {
    const d = chk.dataHora ? new Date(chk.dataHora) : null;
    const dataFmt = d ? d.toLocaleDateString("pt-MZ") : "";
    const horaFmt = d ? d.toLocaleTimeString("pt-MZ", { hour: "2-digit", minute: "2-digit" }) : "";
    const nome = String(chk.alunoNome || "Aluno").replace(/;/g, ",");
    const plano = String(chk.plano || "mensal").replace(/;/g, ",");
    linhas.push(`${dataFmt};${horaFmt};${nome};${plano};Autorizado`);
  });

  const blob = new Blob(["\uFEFF" + linhas.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `historico-treinos-${periodoHistoricoTreinos}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

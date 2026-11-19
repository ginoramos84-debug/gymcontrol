// ============================================================================
// CONFIGURAÇÃO DO SUPABASE — COLA AQUI AS TUAS CHAVES DO PROJETO
// ============================================================================
const SUPABASE_URL = "COLA_AQUI_O_TEU_PROJECT_URL"; // Ex: https://xxxx.supabase.co
const SUPABASE_ANON_KEY = "COLA_AQUI_A_TUA_PUBLISHABLE_KEY"; // Ex: sb_publishable_...

const NUMERO_MPESA_ADMIN = "84 000 0000"; // Atualiza para o teu número M-Pesa
const NUMERO_EMOLA_ADMIN = "87 000 0000"; // Atualiza para o teu número e-Mola
const VALOR_RENOVACAO_MT = 10;
// ============================================================================

const supabaseClient =
  window.supabase &&
  !SUPABASE_URL.startsWith("COLA_AQUI_") &&
  !SUPABASE_ANON_KEY.startsWith("COLA_AQUI_")
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// 1. INICIALIZAR A BASE DE DADOS OFFLINE (IndexedDB via Dexie)
const db = new Dexie("GymControlOfflineDB");

db.version(1).stores({
  config: "id",
  alunos: "++id, nome, telefone, plano, dataExpiracao",
  pagamentos: "++id, alunoId, data, valor, metodo",
  checkins: "++id, alunoId, dataHora"
});

const SEGREDO_MESTRE = "GYM_MOZ_2026_SECRETO";
const CHAVE_SESSAO_LOCAL = "gymcontrol_sessao_autenticada";
let filtroAtualAlunos = "todos";

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

  if (aba === "login") {
    formLogin.classList.remove("hidden");
    formSignup.classList.add("hidden");
    btnLogin.className = "py-2 rounded-lg text-xs font-extrabold transition bg-emerald-500 text-slate-950";
    btnSignup.className = "py-2 rounded-lg text-xs font-bold transition text-slate-400 hover:text-white";
  } else {
    formLogin.classList.add("hidden");
    formSignup.classList.remove("hidden");
    btnSignup.className = "py-2 rounded-lg text-xs font-extrabold transition bg-emerald-500 text-slate-950";
    btnLogin.className = "py-2 rounded-lg text-xs font-bold transition text-slate-400 hover:text-white";
  }
}

function exibirErroAuth(msg) {
  const el = document.getElementById("msg-erro-auth");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
}

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

  const agora = Date.now();
  if (agora < academia.ultimoAcesso) {
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
}

// 3A. LOGIN (Verifica na nuvem se disponível e guarda sessão local)
document.getElementById("form-login").addEventListener("submit", async (e) => {
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
    const agora = Date.now();
    const registroLocal = {
      id: "academia_principal",
      gymId: contaRemota.gym_id,
      nome: contaRemota.nome_academia,
      responsavel: contaRemota.responsavel,
      telefone: contaRemota.telefone,
      senhaHash: contaRemota.senha_hash,
      criadoEm: localAtual?.criadoEm || new Date(contaRemota.criado_em).getTime(),
      ultimoAcesso: agora,
      licencaExpiraEm: new Date(contaRemota.licenca_expira_em).getTime(),
      chavesUsadas: localAtual?.chavesUsadas || [],
      precos: localAtual?.precos || { diario: 100, semanal: 500, mensal: 1500 }
    };

    await db.config.put(registroLocal);
    localStorage.setItem(CHAVE_SESSAO_LOCAL, contaRemota.gym_id);
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
document.getElementById("form-academia").addEventListener("submit", async (e) => {
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
      exibirErroAuth("Este número já utilizou o mês gratuito de teste. Faz login ou renova por 10 MT.");
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

function terminarSessao() {
  localStorage.removeItem(CHAVE_SESSAO_LOCAL);
  if (typeof toggleMenuLateral === "function") toggleMenuLateral(false);
  iniciarApp();
}

// 4. PREÇOS DA ACADEMIA
document.getElementById("form-precos").addEventListener("submit", async (e) => {
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

// 5. RENOVAÇÃO DE 10 MT (M-PESA / E-MOLA) VIA SUPABASE OU CHAVE OFFLINE
document.getElementById("form-ativar-licenca").addEventListener("submit", async (e) => {
  e.preventDefault();
  const metodo = document.getElementById("select-metodo-renovacao").value;
  const codigoInput = document.getElementById("input-chave-licenca").value.trim().toUpperCase();
  const academia = await db.config.get("academia_principal");

  if (!codigoInput || codigoInput.length < 4) {
    exibirErroChave("Introduz um código de transação válido.");
    return;
  }

  // Se for chave mestre offline válida
  const chaveOfflineValida = await verificarChaveOffline(academia.gymId, codigoInput);
  if (chaveOfflineValida) {
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

    alert("Licença renovada com sucesso por mais 30 dias!");
    iniciarApp();
    return;
  }

  // Regista pedido de renovação de 10 MT na tabela renovacoes_licenca do Supabase
  if (supabaseClient && navigator.onLine) {
    const { error } = await supabaseClient
      .from("renovacoes_licenca")
      .insert({
        gym_id: academia.gymId,
        telefone: academia.telefone,
        metodo: metodo,
        codigo_transacao: codigoInput,
        valor: VALOR_RENOVACAO_MT,
        status: "pendente"
      });

    if (error) {
      exibirErroChave("Este código de transação já foi submetido ou é inválido.");
      return;
    }

    exibirErroChave(
      `Comprovativo de ${VALOR_RENOVACAO_MT} MT (${metodo}) registado! Assim que o pagamento for confirmado, a tua licença de +30 dias será ativada.`
    );
    return;
  }

  exibirErroChave("Liga-te à internet para submeter o pagamento de 10 MT ou insere uma chave válida.");
});

// 6. NOVO ALUNO & CAIXA
document.getElementById("form-novo-aluno").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nome = document.getElementById("aluno-nome").value.trim();
  const telefone = document.getElementById("aluno-telefone").value.trim();
  const plano = document.getElementById("aluno-plano").value;
  const metodoPagamento = document.getElementById("pagamento-metodo").value;

  const academia = await db.config.get("academia_principal");
  const precos = academia.precos || { diario: 100, semanal: 500, mensal: 1500 };

  let valorPago = precos.mensal;
  let diasAdicionais = 30;
  if (plano === "diario") { valorPago = precos.diario; diasAdicionais = 1; }
  else if (plano === "semanal") { valorPago = precos.semanal; diasAdicionais = 7; }

  const agora = Date.now();
  const msPorDia = 24 * 60 * 60 * 1000;
  const dataExpiracao = agora + (diasAdicionais * msPorDia);

  const alunoId = await db.alunos.add({
    nome,
    telefone,
    plano,
    dataCadastro: agora,
    dataExpiracao
  });

  await db.pagamentos.add({
    alunoId,
    alunoNome: nome,
    plano,
    valor: valorPago,
    metodo: metodoPagamento,
    dataHora: agora
  });

  document.getElementById("form-novo-aluno").reset();
  atualizarTudo();
  alert(`Aluno ${nome} cadastrado com sucesso! Pagamento de ${valorPago.toLocaleString("pt-MZ")} MT registado.`);
});

// 7. CARREGAMENTO DE ESTATÍSTICAS, CAIXA E ALUNOS
async function atualizarTudo() {
  await carregarAlunosEstatisticasCaixa();
  await carregarCheckinsHoje();
  await carregarRelatoriosFinanceiros();
}

async function carregarAlunosEstatisticasCaixa() {
  const alunos = await db.alunos.toArray();
  const pagamentos = await db.pagamentos.toArray();
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
        <td class="p-3 text-right font-semibold text-emerald-400">${pag.valor.toLocaleString("pt-MZ")} MT</td>
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
      .map(([metodo, valor]) => `<span class="bg-slate-950 border border-slate-800 px-2.5 py-1 rounded-lg text-slate-300">${metodo}: <strong class="text-emerald-400">${valor.toLocaleString("pt-MZ")} MT</strong></span>`)
      .join("");
  }

  const elemCaixa = document.querySelector("#aba-inicio .grid:nth-of-type(1) > div:nth-child(3) .text-3xl");
  if (elemCaixa) elemCaixa.textContent = `${totalCaixaHoje.toLocaleString("pt-MZ")} MT`;

  if (alunos.length === 0) {
    corpoTabela.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500">Nenhum aluno cadastrado ainda.</td></tr>`;
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
    let badgeStatus = expirado
      ? `<span class="bg-red-500/20 text-red-400 text-xs px-2.5 py-1 rounded-full border border-red-500/30 font-semibold">Expirado</span>`
      : prestesAExpirar
      ? `<span class="bg-amber-500/20 text-amber-300 text-xs px-2.5 py-1 rounded-full border border-amber-500/30 font-semibold">Expira em breve</span>`
      : `<span class="bg-emerald-500/20 text-emerald-300 text-xs px-2.5 py-1 rounded-full border border-emerald-500/30">Ativo</span>`;

    const linha = document.createElement("tr");
    linha.innerHTML = `
      <td class="p-3 font-medium text-white">${aluno.nome}</td>
      <td class="p-3 text-slate-300">${aluno.telefone}</td>
      <td class="p-3 capitalize text-slate-300">${aluno.plano}</td>
      <td class="p-3 text-slate-300">${dataFormatada}</td>
      <td class="p-3">${badgeStatus}</td>
      <td class="p-3 text-right">
        <button onclick="abrirModalRenovacao(${aluno.id}, '${aluno.nome.replace(/'/g, "\\'")}')" 
                class="bg-slate-800 hover:bg-emerald-500 hover:text-slate-950 text-slate-200 text-xs font-semibold px-3 py-1.5 rounded-lg transition">
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
        ? "px-3 py-1.5 rounded-lg bg-emerald-500 text-slate-950 font-bold transition"
        : "px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800 transition";
    }
  });
  carregarAlunosEstatisticasCaixa();
}

// 8. MODAL DE RENOVAÇÃO DE PLANO DO ALUNO
async function abrirModalRenovacao(alunoId, nomeAluno) {
  const academia = await db.config.get("academia_principal");
  const precos = academia.precos || { diario: 100, semanal: 500, mensal: 1500 };
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

document.getElementById("form-renovar-aluno").addEventListener("submit", async (e) => {
  e.preventDefault();
  const alunoId = parseInt(document.getElementById("modal-aluno-id").value);
  const plano = document.getElementById("modal-plano-select").value;
  const metodo = document.getElementById("modal-metodo-select").value;

  const aluno = await db.alunos.get(alunoId);
  const academia = await db.config.get("academia_principal");
  const precos = academia.precos || { diario: 100, semanal: 500, mensal: 1500 };

  let valorPago = precos.mensal;
  let diasAdicionais = 30;
  if (plano === "diario") { valorPago = precos.diario; diasAdicionais = 1; }
  if (plano === "semanal") { valorPago = precos.semanal; diasAdicionais = 7; }

  const agora = Date.now();
  const msPorDia = 24 * 60 * 60 * 1000;
  const baseCalculo = aluno.dataExpiracao > agora ? aluno.dataExpiracao : agora;
  const novaExpiracao = baseCalculo + (diasAdicionais * msPorDia);

  await db.alunos.update(alunoId, { plano, dataExpiracao: novaExpiracao });
  await db.pagamentos.add({
    alunoId,
    alunoNome: aluno.nome,
    plano,
    valor: valorPago,
    metodo,
    dataHora: agora
  });

  fecharModalRenovacao();
  atualizarTudo();
  alert(`✅ Plano renovado com sucesso para ${aluno.nome}! (+${valorPago.toLocaleString("pt-MZ")} MT no caixa)`);
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
  document.getElementById("tela-cadastro-academia").classList.add("hidden");
  document.getElementById("tela-bloqueio").classList.add("hidden");
  document.getElementById("painel-principal").classList.add("hidden");
  document.getElementById(idTela).classList.remove("hidden");
}

function mostrarBloqueio(academia) {
  document.getElementById("bloqueio-gym-id").textContent = academia.gymId;
  mostrarTela("tela-bloqueio");
}

function abrirPainelPrincipal(academia, diasRestantes) {
  document.getElementById("header-gym-nome").textContent = academia.nome;
  document.getElementById("header-gym-id").textContent = academia.gymId;

  const badge = document.getElementById("badge-dias-restantes");
  badge.textContent = `${diasRestantes} ${diasRestantes === 1 ? "dia restante" : "dias restantes"}`;
  badge.className = diasRestantes <= 5
    ? "bg-amber-500/15 text-amber-300 text-[11px] font-bold px-2.5 py-1 rounded-full border border-amber-500/30"
    : "bg-emerald-500/15 text-emerald-300 text-[11px] font-bold px-2.5 py-1 rounded-full border border-emerald-500/30";

  mostrarTela("painel-principal");
  atualizarInterfacePrecos(academia);
  atualizarTudo();
}

function exibirErroChave(msg) {
  const el = document.getElementById("msg-erro-chave");
  el.textContent = msg;
  el.classList.remove("hidden");
}

async function simularExpiracao() {
  const ontem = Date.now() - (24 * 60 * 60 * 1000);
  await db.config.update("academia_principal", { licencaExpiraEm: ontem });
  iniciarApp();
}

// 11. CHECK-IN RÁPIDO
const inputPesquisa = document.getElementById("input-pesquisa-checkin");
const boxResultados = document.getElementById("resultados-checkin");

if (inputPesquisa) {
  inputPesquisa.addEventListener("input", async (e) => {
    const termo = e.target.value.trim().toLowerCase();
    if (!termo.length) {
      boxResultados.classList.add("hidden");
      boxResultados.innerHTML = "";
      return;
    }

    const alunos = await db.alunos.toArray();
    const filtrados = alunos.filter(a => a.nome.toLowerCase().includes(termo));
    boxResultados.innerHTML = "";

    if (!filtrados.length) {
      boxResultados.innerHTML = `<div class="p-3 text-sm text-slate-400 text-center">Nenhum aluno encontrado.</div>`;
      boxResultados.classList.remove("hidden");
      return;
    }

    filtrados.forEach(aluno => {
      const expirado = aluno.dataExpiracao < Date.now();
      const dataFormatada = new Date(aluno.dataExpiracao).toLocaleDateString("pt-MZ");
      const statusTexto = expirado ? "EXPIRADO ❌" : "ATIVO ✅";
      const corStatus = expirado ? "text-red-400 bg-red-500/10" : "text-emerald-400 bg-emerald-500/10";

      const item = document.createElement("div");
      item.className = "p-3 hover:bg-slate-800/80 flex justify-between items-center cursor-pointer transition gap-2";
      item.innerHTML = `
        <div>
          <p class="font-medium text-white text-sm">${aluno.nome}</p>
          <p class="text-xs text-slate-400">Tel: ${aluno.telefone} • Expira: ${dataFormatada}</p>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <span class="text-xs px-2.5 py-1 rounded font-semibold ${corStatus}">${statusTexto}</span>
          <button onclick="realizarCheckin(${aluno.id}, '${aluno.nome.replace(/'/g, "\\'")}', ${expirado})" 
                  class="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold px-3 py-1.5 rounded-lg text-xs transition">
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
    alert(`⚠️ ATENÇÃO: A mensalidade de ${nomeAluno} está EXPIRADA!`);
    return;
  }
  await db.checkins.add({ alunoId, alunoNome: nomeAluno, dataHora: Date.now() });
  if (inputPesquisa) inputPesquisa.value = "";
  if (boxResultados) boxResultados.classList.add("hidden");
  alert(`✅ Check-in registado com sucesso para ${nomeAluno}!`);
  carregarCheckinsHoje();
}

async function carregarCheckinsHoje() {
  const checkins = await db.checkins.toArray();
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
      <td class="p-3 text-right"><span class="bg-emerald-500/20 text-emerald-300 text-xs px-2.5 py-1 rounded-full border border-emerald-500/30">Entrada Autorizada</span></td>
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
      versao: "1.0",
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
    alert("✅ Cópia de segurança (Backup) descarregada com sucesso!");
  } catch (err) {
    console.error(err);
    alert("Erro ao gerar o ficheiro de backup.");
  }
}

async function importarBackup(event) {
  const ficheiro = event.target.files[0];
  if (!ficheiro) return;
  if (!confirm("⚠️ Restaurar um backup irá substituir os dados atuais pelos do ficheiro. Continuar?")) {
    event.target.value = "";
    return;
  }

  const leitor = new FileReader();
  leitor.onload = async function(e) {
    try {
      const dados = JSON.parse(e.target.result);
      if (!dados.config || !dados.alunos) throw new Error("Formato inválido");

      await db.transaction("rw", db.config, db.alunos, db.pagamentos, db.checkins, async () => {
        await db.config.clear();
        await db.alunos.clear();
        await db.pagamentos.clear();
        await db.checkins.clear();
        if (dados.config.length) await db.config.bulkAdd(dados.config);
        if (dados.alunos.length) await db.alunos.bulkAdd(dados.alunos);
        if (dados.pagamentos.length) await db.pagamentos.bulkAdd(dados.pagamentos);
        if (dados.checkins.length) await db.checkins.bulkAdd(dados.checkins);
      });

      alert("🔄 Dados restaurados com sucesso!");
      location.reload();
    } catch (err) {
      console.error(err);
      alert("❌ Ficheiro de backup inválido.");
    }
  };
  leitor.readAsText(ficheiro);
}

// 13. RELATÓRIOS FINANCEIROS
async function carregarRelatoriosFinanceiros() {
  const pagamentos = await db.pagamentos.toArray();
  const corpoHistorico = document.getElementById("tabela-historico-geral");
  if (!corpoHistorico) return;
  corpoHistorico.innerHTML = "";

  let totalSemana = 0;
  let totalMes = 0;
  const agora = Date.now();
  const seteDiasAtras = agora - (7 * 24 * 60 * 60 * 1000);
  const inicioMesAtual = new Date();
  inicioMesAtual.setDate(1);
  inicioMesAtual.setHours(0, 0, 0, 0);
  const timestampInicioMes = inicioMesAtual.getTime();

  const pagamentosOrdenados = pagamentos.sort((a, b) => b.dataHora - a.dataHora);

  if (!pagamentosOrdenados.length) {
    corpoHistorico.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-500">Nenhum pagamento registado no histórico.</td></tr>`;
    document.getElementById("relatorio-total-semana").textContent = "0,00 MT";
    document.getElementById("relatorio-total-mes").textContent = "0,00 MT";
    return;
  }

  pagamentosOrdenados.forEach(pag => {
    if (pag.dataHora >= seteDiasAtras) totalSemana += pag.valor;
    if (pag.dataHora >= timestampInicioMes) totalMes += pag.valor;

    const dataFormatada = new Date(pag.dataHora).toLocaleDateString("pt-MZ", { day: "2-digit", month: "2-digit", year: "numeric" });
    const horaFormatada = new Date(pag.dataHora).toLocaleTimeString("pt-MZ", { hour: "2-digit", minute: "2-digit" });

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="p-3 text-slate-400 text-xs">${dataFormatada} ${horaFormatada}</td>
      <td class="p-3 font-medium text-white">${pag.alunoNome || "Aluno"}</td>
      <td class="p-3 capitalize text-slate-300">${pag.plano}</td>
      <td class="p-3 text-slate-300">${pag.metodo}</td>
      <td class="p-3 text-right font-semibold text-emerald-400">${pag.valor.toLocaleString("pt-MZ")} MT</td>
    `;
    corpoHistorico.appendChild(tr);
  });

  document.getElementById("relatorio-total-semana").textContent = `${totalSemana.toLocaleString("pt-MZ")} MT`;
  document.getElementById("relatorio-total-mes").textContent = `${totalMes.toLocaleString("pt-MZ")} MT`;
}

iniciarApp();
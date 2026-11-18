// 1. INICIALIZAR A BASE DE DADOS OFFLINE (IndexedDB via Dexie)
const db = new Dexie("GymControlOfflineDB");

db.version(1).stores({
  config: "id", // Guarda os dados da academia e da licença (apenas 1 registo)
  alunos: "++id, nome, telefone, plano, dataExpiracao", // Cadastro de alunos
  pagamentos: "++id, alunoId, data, valor, metodo", // Fluxo de caixa
  checkins: "++id, alunoId, dataHora" // Controlo de frequência
});

// Chave secreta usada para validar as licenças
const SEGREDO_MESTRE = "GYM_MOZ_2026_SECRETO";

// Variável para guardar o filtro ativo na tabela de alunos
let filtroAtualAlunos = "todos";

// 2. FUNÇÃO PRINCIPAL QUE ARRANCA QUANDO O APP ABRE
async function iniciarApp() {
  const academia = await db.config.get("academia_principal");

  if (!academia) {
    mostrarTela("tela-cadastro-academia");
    return;
  }

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

// 3. REGISTAR A ACADEMIA PELA PRIMEIRA VEZ (ATIVA 30 DIAS GRÁTIS)
document.getElementById("form-academia").addEventListener("submit", async (e) => {
  e.preventDefault();

  const nome = document.getElementById("gym-nome").value.trim();
  const responsavel = document.getElementById("gym-responsavel").value.trim();
  const telefone = document.getElementById("gym-telefone").value.trim();

  const idUnico = "GYM-" + Math.floor(1000 + Math.random() * 9000);
  const agora = Date.now();
  const trintaDiasEmMs = 30 * 24 * 60 * 60 * 1000;

  const novaAcademia = {
    id: "academia_principal",
    gymId: idUnico,
    nome: nome,
    responsavel: responsavel,
    telefone: telefone,
    criadoEm: agora,
    ultimoAcesso: agora,
    licencaExpiraEm: agora + trintaDiasEmMs,
    chavesUsadas: [],
    precos: {
      diario: 100,
      semanal: 500,
      mensal: 1500
    }
  };

  await db.config.put(novaAcademia);
  iniciarApp();
});

// 4. SALVAR NOVOS PREÇOS DEFINIDOS PELO DONO
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

// 5. VALIDAR CHAVE DE RENOVAÇÃO OFFLINE
document.getElementById("form-ativar-licenca").addEventListener("submit", async (e) => {
  e.preventDefault();
  const chaveDigitada = document.getElementById("input-chave-licenca").value.trim().toUpperCase();
  const academia = await db.config.get("academia_principal");

  if (academia.chavesUsadas && academia.chavesUsadas.includes(chaveDigitada)) {
    exibirErroChave("Esta chave já foi utilizada anteriormente.");
    return;
  }

  const valida = await verificarChaveOffline(academia.gymId, chaveDigitada);

  if (valida) {
    const agora = Date.now();
    const mais30Dias = 30 * 24 * 60 * 60 * 1000;
    const novasChaves = [...(academia.chavesUsadas || []), chaveDigitada];

    await db.config.update("academia_principal", {
      licencaExpiraEm: agora + mais30Dias,
      ultimoAcesso: agora,
      chavesUsadas: novasChaves
    });

    alert("Licença renovada com sucesso por mais 30 dias!");
    iniciarApp();
  } else {
    exibirErroChave("Chave inválida para este ginásio. Confirma o código e tenta novamente.");
  }
});

// 6. REGISTAR NOVO ALUNO, CALCULAR EXPIRAÇÃO E LANÇAR NO CAIXA
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

  if (plano === "diario") {
    valorPago = precos.diario;
    diasAdicionais = 1;
  } else if (plano === "semanal") {
    valorPago = precos.semanal;
    diasAdicionais = 7;
  }

  const agora = Date.now();
  const msPorDia = 24 * 60 * 60 * 1000;
  const dataExpiracao = agora + (diasAdicionais * msPorDia);

  const alunoId = await db.alunos.add({
    nome: nome,
    telefone: telefone,
    plano: plano,
    dataCadastro: agora,
    dataExpiracao: dataExpiracao
  });

  await db.pagamentos.add({
    alunoId: alunoId,
    alunoNome: nome,
    plano: plano,
    valor: valorPago,
    metodo: metodoPagamento,
    dataHora: agora
  });

  document.getElementById("form-novo-aluno").reset();
  atualizarTudo();
  alert(`Aluno ${nome} cadastrado com sucesso! Pagamento de ${valorPago.toLocaleString("pt-MZ")} MT registado.`);
});

// 7. FUNÇÃO CENTRAL DE CARREGAMENTO (ESTATÍSTICAS, CAIXA, ALUNOS E RELATÓRIOS)
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

  let totalAvulsos = 0;
  let totalExpiramEmBreve = 0;
  let totalCaixaHoje = 0;
  const totaisPorMetodo = { "Dinheiro": 0, "M-Pesa": 0, "e-Mola": 0, "POS": 0 };

  const agora = Date.now();
  const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;
  const hojeInicio = new Date().setHours(0, 0, 0, 0);

  // Processar Pagamentos de Hoje
  const corpoPagamentos = document.getElementById("tabela-pagamentos-corpo");
  if (corpoPagamentos) corpoPagamentos.innerHTML = "";

  const pagamentosHoje = pagamentos
    .filter(p => p.dataHora >= hojeInicio)
    .sort((a, b) => b.dataHora - a.dataHora);

  pagamentosHoje.forEach(pag => {
    totalCaixaHoje += pag.valor;
    if (totaisPorMetodo[pag.metodo] !== undefined) {
      totaisPorMetodo[pag.metodo] += pag.valor;
    }

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
      .map(([metodo, valor]) => `<span class="bg-slate-900 border border-slate-700 px-2.5 py-1 rounded text-slate-300">${metodo}: <strong class="text-emerald-400">${valor.toLocaleString("pt-MZ")} MT</strong></span>`)
      .join("");
  }

  if (alunos.length === 0) {
    corpoTabela.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500">Nenhum aluno cadastrado ainda.</td></tr>`;
    document.getElementById("stat-total-alunos").textContent = "0";
    document.getElementById("stat-expiram-breve").textContent = "0";
    return;
  } else {
    document.getElementById("stat-total-alunos").textContent = alunos.length;
  }

  alunos.forEach(aluno => {
    const expirado = aluno.dataExpiracao < agora;
    const prestesAExpirar = !expirado && (aluno.dataExpiracao <= (agora + tresDiasEmMs));

    // Aplicar Filtro da Tabela de Alunos
    if (filtroAtualAlunos === "ativos" && (expirado || prestesAExpirar)) return;
    if (filtroAtualAlunos === "breve" && !prestesAExpirar) return;
    if (filtroAtualAlunos === "expirados" && !expirado) return;

    const dataFormatada = new Date(aluno.dataExpiracao).toLocaleDateString("pt-MZ");

    if (aluno.plano === "diario" || aluno.plano === "semanal") totalAvulsos++;
    if (prestesAExpirar) totalExpiramEmBreve++;

    let badgeStatus = "";
    if (expirado) {
      badgeStatus = `<span class="bg-red-500/20 text-red-400 text-xs px-2.5 py-1 rounded-full border border-red-500/30 font-semibold">Expirado</span>`;
    } else if (prestesAExpirar) {
      badgeStatus = `<span class="bg-amber-500/20 text-amber-300 text-xs px-2.5 py-1 rounded-full border border-amber-500/30 font-semibold">Expira em breve</span>`;
    } else {
      badgeStatus = `<span class="bg-emerald-500/20 text-emerald-300 text-xs px-2.5 py-1 rounded-full border border-emerald-500/30">Ativo</span>`;
    }

    const linha = document.createElement("tr");
    linha.innerHTML = `
      <td class="p-3 font-medium text-white">${aluno.nome}</td>
      <td class="p-3 text-slate-300">${aluno.telefone}</td>
      <td class="p-3 capitalize text-slate-300">${aluno.plano}</td>
      <td class="p-3 text-slate-300">${dataFormatada}</td>
      <td class="p-3">${badgeStatus}</td>
      <td class="p-3 text-right">
        <button onclick="abrirModalRenovacao(${aluno.id}, '${aluno.nome.replace(/'/g, "\\'")}')" 
                class="bg-slate-700 hover:bg-emerald-500 hover:text-slate-950 text-slate-200 text-xs font-semibold px-3 py-1.5 rounded transition">
          Renovar
        </button>
      </td>
    `;
    corpoTabela.appendChild(linha);
  });

  const elemExpiramBreve = document.getElementById("stat-expiram-breve");
  if (elemExpiramBreve) elemExpiramBreve.textContent = totalExpiramEmBreve;

  const elemCaixa = document.querySelector("#painel-principal .grid:nth-of-type(1) .bg-slate-800:nth-child(3) .text-3xl");
  if (elemCaixa) elemCaixa.textContent = `${totalCaixaHoje.toLocaleString("pt-MZ")} MT`;
}

// Filtro rápido de alunos
function filtrarAlunos(tipo) {
  filtroAtualAlunos = tipo;
  ["todos", "ativos", "breve", "expirados"].forEach(t => {
    const btn = document.getElementById(`filtro-${t}`);
    if (btn) {
      if (t === tipo) {
        btn.className = "px-3 py-1.5 rounded-lg bg-emerald-500 text-slate-950 font-bold transition";
      } else {
        btn.className = "px-3 py-1.5 rounded-lg bg-slate-900 text-slate-300 hover:bg-slate-700 transition";
      }
    }
  });
  carregarAlunosEstatisticasCaixa();
}

// 8. MODAL DE RENOVAÇÃO DE PLANO
async function abrirModalRenovacao(alunoId, nomeAluno) {
  const academia = await db.config.get("academia_principal");
  const precos = academia.precos || { diario: 100, semanal: 500, mensal: 1500 };

  document.getElementById("modal-aluno-id").value = alunoId;
  document.getElementById("modal-aluno-nome").textContent = `Aluno: ${nomeAluno}`;

  const selectModal = document.getElementById("modal-plano-select");
  selectModal.innerHTML = `
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

  await db.alunos.update(alunoId, {
    plano: plano,
    dataExpiracao: novaExpiracao
  });

  await db.pagamentos.add({
    alunoId: alunoId,
    alunoNome: aluno.nome,
    plano: plano,
    valor: valorPago,
    metodo: metodo,
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

  const lote = partes[0];
  const assinaturaRecebida = partes[1];

  const textoParaAssinar = `${gymId}|${lote}|${SEGREDO_MESTRE}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(textoParaAssinar);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();

  return assinaturaRecebida === hashHex.substring(0, 6);
}

// 10. INTERFACE DE TELAS E BLOQUEIO
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
  badge.textContent = `${diasRestantes} ${diasRestantes === 1 ? 'dia restante' : 'dias restantes'}`;
  
  if (diasRestantes <= 5) {
    badge.className = "bg-amber-500/20 text-amber-300 text-xs font-semibold px-3 py-1.5 rounded-full border border-amber-500/30";
  }

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

// 11. MOTOR DE PESQUISA E CHECK-IN RÁPIDO
const inputPesquisa = document.getElementById("input-pesquisa-checkin");
const boxResultados = document.getElementById("resultados-checkin");

if (inputPesquisa) {
  inputPesquisa.addEventListener("input", async (e) => {
    const termo = e.target.value.trim().toLowerCase();
    
    if (termo.length === 0) {
      boxResultados.classList.add("hidden");
      boxResultados.innerHTML = "";
      return;
    }

    const alunos = await db.alunos.toArray();
    const filtrados = alunos.filter(a => a.nome.toLowerCase().includes(termo));

    boxResultados.innerHTML = "";

    if (filtrados.length === 0) {
      boxResultados.innerHTML = `<div class="p-3 text-sm text-slate-400 text-center">Nenhum aluno encontrado.</div>`;
      boxResultados.classList.remove("hidden");
      return;
    }

    filtrados.forEach(aluno => {
      const agora = Date.now();
      const expirado = aluno.dataExpiracao < agora;
      const dataFormatada = new Date(aluno.dataExpiracao).toLocaleDateString("pt-MZ");

      let statusTexto = expirado ? "EXPIRADO ❌" : "ATIVO ✅";
      let corStatus = expirado ? "text-red-400 bg-red-500/10" : "text-emerald-400 bg-emerald-500/10";

      const item = document.createElement("div");
      item.className = "p-3 hover:bg-slate-800 flex justify-between items-center cursor-pointer transition";
      item.innerHTML = `
        <div>
          <p class="font-medium text-white text-sm">${aluno.nome}</p>
          <p class="text-xs text-slate-400">Tel: ${aluno.telefone} • Expira: ${dataFormatada}</p>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs px-2.5 py-1 rounded font-semibold ${corStatus}">${statusTexto}</span>
          <button onclick="realizarCheckin(${aluno.id}, '${aluno.nome.replace(/'/g, "\\'")}', ${expirado})" 
                  class="bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold px-3 py-1.5 rounded text-xs transition">
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
    alert(`⚠️ ATENÇÃO: A mensalidade de ${nomeAluno} está EXPIRADA! O acesso deve ser condicionado até efetuar o pagamento.`);
    return;
  }

  const agora = Date.now();

  await db.checkins.add({
    alunoId: alunoId,
    alunoNome: nomeAluno,
    dataHora: agora
  });

  if (inputPesquisa) inputPesquisa.value = "";
  if (boxResultados) boxResultados.classList.add("hidden");

  alert(`✅ Check-in registado com sucesso para ${nomeAluno}! Entrada autorizada.`);
  carregarCheckinsHoje();
}

async function carregarCheckinsHoje() {
  const checkins = await db.checkins.toArray();
  const corpoCheckins = document.getElementById("tabela-checkins-hoje");
  if (!corpoCheckins) return;

  corpoCheckins.innerHTML = "";
  const hojeInicio = new Date().setHours(0, 0, 0, 0);

  const checkinsHoje = checkins
    .filter(c => c.dataHora >= hojeInicio)
    .sort((a, b) => b.dataHora - a.dataHora);

  if (checkinsHoje.length === 0) {
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

// 12. BACKUP E RESTAURAÇÃO (JSON)
async function exportarBackup() {
  try {
    const configData = await db.config.toArray();
    const alunosData = await db.alunos.toArray();
    const pagamentosData = await db.pagamentos.toArray();
    const checkinsData = await db.checkins.toArray();

    const backupCompleto = {
      versao: "1.0",
      dataExportacao: new Date().toISOString(),
      config: configData,
      alunos: alunosData,
      pagamentos: pagamentosData,
      checkins: checkinsData
    };

    const jsonStr = JSON.stringify(backupCompleto, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const dataFormatada = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `backup-gymcontrol-${dataFormatada}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    alert("✅ Cópia de segurança (Backup) descarregada com sucesso!");
  } catch (err) {
    console.error("Erro ao exportar backup:", err);
    alert("Erro ao gerar o ficheiro de backup.");
  }
}

async function importarBackup(event) {
  const ficheiro = event.target.files[0];
  if (!ficheiro) return;

  const confirmar = confirm("⚠️ ATENÇÃO: Restaurar um backup irá substituir os dados atuais pelos do ficheiro. Desejas continuar?");
  if (!confirmar) {
    event.target.value = "";
    return;
  }

  const leitor = new FileReader();
  leitor.onload = async function(e) {
    try {
      const dados = JSON.parse(e.target.result);

      if (!dados.config || !dados.alunos) {
        throw new Error("Formato de ficheiro inválido.");
      }

      await db.transaction("rw", db.config, db.alunos, db.pagamentos, db.checkins, async () => {
        await db.config.clear();
        await db.alunos.clear();
        await db.pagamentos.clear();
        await db.checkins.clear();

        if (dados.config.length > 0) await db.config.bulkAdd(dados.config);
        if (dados.alunos.length > 0) await db.alunos.bulkAdd(dados.alunos);
        if (dados.pagamentos.length > 0) await db.pagamentos.bulkAdd(dados.pagamentos);
        if (dados.checkins.length > 0) await db.checkins.bulkAdd(dados.checkins);
      });

      alert("🔄 Dados restaurados com sucesso! O aplicativo vai reiniciar.");
      location.reload();
    } catch (err) {
      console.error("Erro ao importar:", err);
      alert("❌ Erro ao ler o ficheiro de backup. Certifica-te de que é um ficheiro GymControl válido.");
    }
  };

  leitor.readAsText(ficheiro);
}

// 13. RELATÓRIOS FINANCEIROS (SEMANA E MÊS)
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

  if (pagamentosOrdenados.length === 0) {
    corpoHistorico.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-500">Nenhum pagamento registado no histórico.</td></tr>`;
    document.getElementById("relatorio-total-semana").textContent = "0,00 MT";
    document.getElementById("relatorio-total-mes").textContent = "0,00 MT";
    return;
  }

  pagamentosOrdenados.forEach(pag => {
    if (pag.dataHora >= seteDiasAtras) {
      totalSemana += pag.valor;
    }
    if (pag.dataHora >= timestampInicioMes) {
      totalMes += pag.valor;
    }

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

// Arranca o sistema
iniciarApp();
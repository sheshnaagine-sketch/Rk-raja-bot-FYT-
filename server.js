// clean_bot_full.js
const express = require('express');
const bodyParser = require('body-parser');
const login = require('ws3-fca');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// === GLOBAL STATE ===
let botAPI = null;
let adminID = null;
let prefix = '/';
let botNickname = 'LEGEND PRINCE';
let lockedGroups = {};       // threadID -> title
let lockedNicknames = {};    // threadID -> nickname
let lockedTargets = {};      // threadID -> targetUserID (string)
let autoAddUsers = {};       // threadID -> { [userID]: true }  
let currentCookies = null;
let reconnectAttempt = 0;
let conversationState = {}; // threadID -> stage

// Track last message to avoid spam replies
let lastMessageTime = {}; // threadID -> timestamp

const signature = `\n\n— RK RAJA XWD 🌿💕`;
const separator = `\n------------------------------`;

// === MASTI AUTO REPLY ===
const mastiReplies = [
  "TER1 BEHEN K1 CHOOT KO MUJHE CHODNE ME B4D4 M4Z4 4RH4 H41 BEHENCHOD KE D1NNE K1N4R K1 4UL44D HEHEHEHEH <3😆",
  "TER1 TER1 BEHEN K1 CHOOT TO K4L4P K4L4P KE LOWD4 CHUSE J44 RH1 H41 HEN HEN BEHENCHOD KE D1NNE =]]😂",
  "44J4 BEHCOD KE LOWDE TER1 BEHEN K1 CHOOT KO M41 CHOD J4UNG4 LOWDE KE B44L R4ND1 KE D1NNE =]]😎",
  "TER1 BEHEN K1 CHOOT =]] F4T1 J44 RH1 H41 BHOSD KE B| TER1 BEHEN K1 CHOOT 1TN4 K4L4P K1YO RH1 H41 REEE R4ND1 KE B4CHEW =]]😜",
  "TER1 BEHEN KE BHOSDE ME M41 LOWD4 D44L KR TER1 BEHEN K1 CHOOT KO M41 CHOD J4UNG4 LOWDE KE B4CHEW 44J4 BEHCOD KE LOWDE =]]🤣",
  "TER1 B44J1 K1 CHOOT ME M41 SUNEH4R1 LOWDE KE 4T4KDEER L4G4 DUNG4 R44ND KE B4CHEW K1 TER1 BEHEN K1 BOOR K4PTE T4B4H1G1 LOWDE <3🔥",
  "TER1 BEHEN K1 CHOOT KO M41 CHOD M4RU BEHENCHOD KE LOWDE R4ND1 KE D1NNE =]]💕",
  "TER1 BEHEN K1 G44ND ME M41 LOWD4 M4RUNG4 BHOSD CHOD KE 4UL44D S4LE G4NDE N44L1 KE G4NDE B4CHEW BHOSDKE =]]😏",
  "M41 TER1 M44 KO K41SE CHODT4 HUN 44J TUJHE Y44D D1L4 DUNG4 R444ND KE B4CHEW :v 44J M41 TUJHE RUL RUL4 KE CHODUNG4 BEHHNCHOD KE D1NNE :v😂",
  "MERE B4CHEW 44J4 MERE LOWDE _||_ PE JHOOM M4THERCHOD KE GH4ST1 KE B4CHEW <3 TER1 BEHEN K1 CHOOT ME M41 B4ST1 B4S4 DU :v🤭",
  "4J4 =]] REG1ST44N KE D1NNE TER1 BEHEN K1 G44ND M4RU LOWDE KE D1NNE B|😁",
  "R4ND1 1NSH44N KE R4ND1 B4CHEW TER1 BEHEN K1 CHOOT KO M41 CHODTE J4UNG4 LOWDE KE D1NNE TER1 BEHEN K1 G44ND KO M41 CHEER J4U =]] 😘"
];

// === LOG SYSTEM ===
function emitLog(message, isError = false) {
  const logMessage = `[${new Date().toISOString()}] ${isError ? 'ERROR: ' : 'INFO: '}${message}`;
  console.log(logMessage);
  io.emit('botlog', logMessage);
}

function saveConfig() {
  try {
    const toSave = {
      botNickname,
      cookies: currentCookies || null,
      adminID,
      prefix,
      lockedGroups,
      lockedNicknames,
      lockedTargets,
      autoAddUsers
    };
    fs.writeFileSync('config.json', JSON.stringify(toSave, null, 2));
    emitLog('Configuration saved.');
  } catch (e) {
    emitLog('Failed to save config: ' + e.message, true);
  }
}

// === BOT INIT ===
function initializeBot(cookies, prefixArg, adminArg) {
  emitLog('Initializing bot...');
  currentCookies = cookies;
  if (prefixArg) prefix = prefixArg;
  if (adminArg) adminID = adminArg;
  reconnectAttempt = 0;

  login({ appState: currentCookies }, (err, api) => {
    if (err) {
      emitLog(`Login error: ${err.message}. Retrying in 10s.`, true);
      setTimeout(() => initializeBot(currentCookies, prefix, adminID), 10000);
      return;
    }

    emitLog('Bot logged in successfully.');
    botAPI = api;
    botAPI.setOptions({ selfListen: true, listenEvents: true, updatePresence: false });

    setTimeout(async () => {
      try { await setBotNicknamesInGroups(); } catch (e) { emitLog('Error restoring nicknames: ' + e.message, true); }
      startListening(api);
    }, 2000);

    setInterval(saveConfig, 5 * 60 * 1000);
  });
}

// === RECONNECT SYSTEM ===
function reconnectAndListen() {
  reconnectAttempt++;
  emitLog(`Reconnect attempt #${reconnectAttempt}...`);
  if (botAPI) {
    try { botAPI.stopListening(); } catch {}
  }

  if (reconnectAttempt > 5) {
    emitLog('Max reconnect attempts reached; reinitializing login.', true);
    initializeBot(currentCookies, prefix, adminID);
  } else {
    setTimeout(() => {
      if (botAPI) startListening(botAPI);
      else initializeBot(currentCookies, prefix, adminID);
    }, 5000);
  }
}

// === LISTENER ===
function startListening(api) {
  api.listenMqtt(async (err, event) => {
    if (err) {
      emitLog('Listener error: ' + err.message, true);
      reconnectAndListen();
      return;
    }

    try {
      if (event.type === 'message' || event.type === 'message_reply') {
        await handleMessage(api, event);
      } else if (event.logMessageType === 'log:thread-name') {
        await handleThreadNameChange(api, event);
      } else if (event.logMessageType === 'log:user-nickname') {
        await handleNicknameChange(api, event);
      } else if (event.logMessageType === 'log:subscribe') {
        await handleBotAddedToGroup(api, event);
      } else if (event.logMessageType === 'log:unsubscribe') {
        await handleUserLeftGroup(api, event);
      }
    } catch (e) {
      emitLog('Handler crashed: ' + e.message, true);
    }
  });
}

// === FORMAT MESSAGE (TAG SYSTEM) ===
async function formatMessage(api, event, mainText) {
  const { senderID, threadID } = event;
  let senderName = 'User';

  try {
    const info = await api.getUserInfo(senderID);
    senderName = info?.[senderID]?.name || null;

    // Fix if "Facebook User"
    if (!senderName || senderName.toLowerCase().includes('facebook user')) {
      const thread = await api.getThreadInfo(threadID);
      const user = thread.userInfo.find(u => u.id === senderID);
      senderName = user?.name || `User-${senderID}`;
    }
  } catch {
    senderName = `User-${senderID}`;
  }

  return {
    body: `@${senderName} ${mainText}\n\n— 💕RK RAJA XWD  💕\n------------------------------`,
    mentions: [{ tag: `@${senderName}`, id: senderID }]
  };
}

// === MESSAGE HANDLER ===
async function handleMessage(api, event) {
  const { threadID, senderID, body } = event;
  if (!body) return;
  const msg = body.toLowerCase();

  // Ignore messages from the bot itself
  const botID = api.getCurrentUserID && api.getCurrentUserID();
  if (senderID === botID) return;

  // === MULTI-TARGET SYSTEM: Check if user is in target list ===
  const targets = lockedTargets[threadID] || [];
  const isAdmin = senderID === adminID;
  const isCommand = body.startsWith(prefix);

  // NEW MULTI-TARGET SYSTEM: Bot only replies when targets are set and user is in target list
  if (targets && targets.length > 0) {
    // Only allow:
    // 1. Target users' messages (normal replies)
    // 2. Admin commands (commands only)
    if (targets.includes(senderID)) {
      // Target user allowed - proceed to normal conversation
    } else if (isAdmin && isCommand) {
      // Admin commands allowed - handle command then return
      return await handleAdminCommand(api, event, body, isAdmin);
    } else {
      // All others ignored (including admin non-command messages and non-target users)
      if (isCommand && !isAdmin) {
        // Non-admin trying to use commands while target is locked -> deny
        await api.sendMessage({ body: `You don't have permission to use commands while target is locked.`, mentions: [] }, threadID);
      }
      return; // Ignore all other messages
    }
  } else {
    // NO TARGET SET: Only admin commands are processed, no auto-replies
    if (isCommand && isAdmin) {
      return await handleAdminCommand(api, event, body, isAdmin);
    }
    return; // Ignore all messages when no target is set
  }

  // Avoid multiple replies in quick succession (spam stop)
  const now = Date.now();
  if (lastMessageTime[threadID] && now - lastMessageTime[threadID] < 1500) return;
  lastMessageTime[threadID] = now;

  // === Normal conversation for target user ===
  if (!conversationState[threadID]) conversationState[threadID] = 0;

  // === Conversation flow for non-command messages ===
  if (conversationState[threadID] === 0 && msg.includes('hello')) {
    const reply = await formatMessage(api, event, 'hello I am fine');
    await api.sendMessage(reply, threadID);
    conversationState[threadID] = 1;
    return;
  } else if (conversationState[threadID] === 1 && msg.includes('hi kaise ho')) {
    const reply = await formatMessage(api, event, 'thik hu tum kaise ho');
    await api.sendMessage(reply, threadID);
    conversationState[threadID] = 0;
    return;
  }

  // === MASTI AUTO REPLY for target user ===
  const randomReply = mastiReplies[Math.floor(Math.random() * mastiReplies.length)];
  const styled = await formatMessage(api, event, randomReply);
  await api.sendMessage(styled, threadID);
}

// === ADMIN COMMAND HANDLER ===
async function handleAdminCommand(api, event, body, isAdmin) {
  const { threadID } = event;
  
  const args = body.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // Command routing
  if (command === 'group') return handleGroupCommand(api, event, args, isAdmin);
  if (command === 'nickname') return handleNicknameCommand(api, event, args, isAdmin);
  if (command === 'target') return handleTargetCommand(api, event, args, isAdmin);
  if (command === 'autoadd') return handleAutoAddCommand(api, event, args, isAdmin);

  const help = await formatMessage(api, event, `‎═══════════════════
𝐠𝐫𝐨𝐮𝐩 𝐨𝐧/𝐨𝐟𝐟 → 𝐋𝐎𝐂𝐊 𝐆𝐑𝐎𝐔𝐏 𝐍𝐀𝐌𝐄
𝐧𝐢𝐜𝐤𝐧𝐚𝐦𝐞 𝐨𝐧/𝐨𝐟𝐟 → 𝐋𝐎𝐂𝐊 𝐍𝐈𝐂𝐊𝐍𝐀𝐌𝐄
𝐭𝐚𝐫𝐠𝐞𝐭 𝐚𝐝𝐝/𝐫𝐞𝐦/𝐥𝐢𝐬𝐭/𝐜𝐥𝐞𝐚𝐫 <userID> → 𝐌𝐔𝐋𝐓𝐈 𝐓𝐀𝐑𝐆𝐄𝐓
𝐚𝐮𝐭𝐨𝐚𝐝𝐝 𝐨𝐧/𝐨𝐟𝐟 <userID> → 𝐀𝐔𝐓𝐎 𝐀𝐃𝐃 𝐔𝐒𝐄𝐑
═══════════════════`);
  return api.sendMessage(help, threadID);
}

// === GROUP COMMAND ===
async function handleGroupCommand(api, event, args, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return api.sendMessage(await formatMessage(api, event, 'Permission denied: admin only.'), threadID);

  const sub = (args.shift() || '').toLowerCase();
  if (sub === 'on') {
    const name = args.join(' ').trim();
    if (!name) return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}group on <name>`), threadID);
    lockedGroups[threadID] = name;
    try { await api.setTitle(name, threadID); } catch {}
    saveConfig();
    return api.sendMessage(await formatMessage(api, event, `Group name locked to "${name}".`), threadID);
  } else if (sub === 'off') {
    delete lockedGroups[threadID];
    saveConfig();
    return api.sendMessage(await formatMessage(api, event, 'Group name unlocked.'), threadID);
  } else {
    return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}group on/off`), threadID);
  }
}

// === NICKNAME COMMAND ===
async function handleNicknameCommand(api, event, args, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return api.sendMessage(await formatMessage(api, event, 'Permission denied: admin only.'), threadID);

  const sub = (args.shift() || '').toLowerCase();
  if (sub === 'on') {
    const nick = args.join(' ').trim();
    if (!nick) return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}nickname on <nick>`), threadID);
    lockedNicknames[threadID] = nick;
    try {
      const info = await api.getThreadInfo(threadID);
      for (const pid of info.participantIDs || []) {
        if (pid !== adminID) {
          await api.changeNickname(nick, threadID, pid);
          await new Promise(r => setTimeout(r, 200));
        }
      }
    } catch {}
    saveConfig();
    return api.sendMessage(await formatMessage(api, event, `Nicknames locked to "${nick}".`), threadID);
  } else if (sub === 'off') {
    delete lockedNicknames[threadID];
    saveConfig();
    return api.sendMessage(await formatMessage(api, event, 'Nickname lock disabled.'), threadID);
  } else {
    return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}nickname on/off`), threadID);
  }
}

// === TARGET COMMAND (UPDATED FOR MULTI-TARGET) ===
async function handleTargetCommand(api, event, args, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return api.sendMessage(await formatMessage(api, event, 'Permission denied: admin only.'), threadID);

  const sub = (args.shift() || '').toLowerCase();
  
  // Initialize targets array for this thread if not exists
  if (!lockedTargets[threadID]) {
    lockedTargets[threadID] = [];
  }

  if (sub === 'add') {
    const userID = args.join(' ').trim();
    if (!userID) {
      return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}target add <userID>`), threadID);
    }

    // Add user to targets if not already present
    if (!lockedTargets[threadID].includes(userID)) {
      lockedTargets[threadID].push(userID);
      saveConfig();
      return api.sendMessage(await formatMessage(api, event, `Added "${userID}" to target list. Current targets: ${lockedTargets[threadID].join(', ')}`), threadID);
    } else {
      return api.sendMessage(await formatMessage(api, event, `User "${userID}" is already in target list.`), threadID);
    }

  } else if (sub === 'rem' || sub === 'remove') {
    const userID = args.join(' ').trim();
    if (!userID) {
      return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}target rem <userID>`), threadID);
    }

    // Remove user from targets
    const index = lockedTargets[threadID].indexOf(userID);
    if (index > -1) {
      lockedTargets[threadID].splice(index, 1);
      saveConfig();
      return api.sendMessage(await formatMessage(api, event, `Removed "${userID}" from target list. Current targets: ${lockedTargets[threadID].join(', ') || 'None'}`), threadID);
    } else {
      return api.sendMessage(await formatMessage(api, event, `User "${userID}" not found in target list.`), threadID);
    }

  } else if (sub === 'list') {
    if (lockedTargets[threadID] && lockedTargets[threadID].length > 0) {
      return api.sendMessage(await formatMessage(api, event, `Current targets: ${lockedTargets[threadID].join(', ')}`), threadID);
    } else {
      return api.sendMessage(await formatMessage(api, event, 'No targets set. Bot will not reply to anyone.'), threadID);
    }

  } else if (sub === 'clear') {
    lockedTargets[threadID] = [];
    saveConfig();
    return api.sendMessage(await formatMessage(api, event, 'Target list cleared. Bot will not reply to anyone.'), threadID);

  } else {
    return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}target add/rem/list/clear <userID>`), threadID);
  }
}

// === AUTO ADD COMMAND ===
async function handleAutoAddCommand(api, event, args, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return api.sendMessage(await formatMessage(api, event, 'Permission denied: admin only.'), threadID);

  const sub = (args.shift() || '').toLowerCase();
  
  if (sub === 'on') {
    const userID = args.join(' ').trim();
    if (!userID) {
      return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}autoadd on <userID>`), threadID);
    }

    // Initialize autoAddUsers for this thread if not exists
    if (!autoAddUsers[threadID]) {
      autoAddUsers[threadID] = {};
    }

    // Add user to auto-add list
    autoAddUsers[threadID][userID] = true;
    saveConfig();
    
    return api.sendMessage(await formatMessage(api, event, `Auto-add enabled for user ${userID}. Bot will automatically add this user back if they leave.`), threadID);
    
  } else if (sub === 'off') {
    const userID = args.join(' ').trim();
    if (!userID) {
      return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}autoadd off <userID>`), threadID);
    }

    if (autoAddUsers[threadID] && autoAddUsers[threadID][userID]) {
      delete autoAddUsers[threadID][userID];
      // If no more auto-add users in this thread, remove the thread entry
      if (Object.keys(autoAddUsers[threadID]).length === 0) {
        delete autoAddUsers[threadID];
      }
      saveConfig();
      return api.sendMessage(await formatMessage(api, event, `Auto-add disabled for user ${userID}.`), threadID);
    } else {
      return api.sendMessage(await formatMessage(api, event, `Auto-add was not enabled for user ${userID}.`), threadID);
    }
    
  } else if (sub === 'list') {
    if (!autoAddUsers[threadID] || Object.keys(autoAddUsers[threadID]).length === 0) {
      return api.sendMessage(await formatMessage(api, event, 'No users in auto-add list for this group.'), threadID);
    }
    
    const userList = Object.keys(autoAddUsers[threadID]).join(', ');
    return api.sendMessage(await formatMessage(api, event, `Auto-add users in this group:\n${userList}`), threadID);
    
  } else {
    return api.sendMessage(await formatMessage(api, event, `Usage: ${prefix}autoadd on/off/list <userID>`), threadID);
  }
}

// === HANDLE USER LEFT GROUP ===
async function handleUserLeftGroup(api, event) {
  const { threadID, logMessageData } = event;
  
  // Check if anyone left and if we have auto-add users in this group
  if (logMessageData?.leftParticipantFbId && autoAddUsers[threadID]) {
    const leftUserID = String(logMessageData.leftParticipantFbId);
    
    // Check if this user is in our auto-add list
    if (autoAddUsers[threadID][leftUserID]) {
      emitLog(`Auto-adding user ${leftUserID} back to group ${threadID}`);
      
      try {
        // Add the user back to the group
        await api.addUserToGroup(leftUserID, threadID);
        
        // Send confirmation message
        await api.sendMessage(await formatMessage(api, event, `Automatically added user ${leftUserID} back to the group.`), threadID);
        
        emitLog(`Successfully auto-added user ${leftUserID} to group ${threadID}`);
      } catch (error) {
        emitLog(`Failed to auto-add user ${leftUserID}: ${error.message}`, true);
        await api.sendMessage(await formatMessage(api, event, `Failed to auto-add user ${leftUserID}. They may have privacy restrictions.`), threadID);
      }
    }
  }
}

// === AUTO RESTORE ===
async function setBotNicknamesInGroups() {
  if (!botAPI) return;
  try {
    const threads = await botAPI.getThreadList(100, null, ['GROUP']);
    const botID = botAPI.getCurrentUserID();
    for (const thread of threads) {
      const info = await botAPI.getThreadInfo(thread.threadID);
      if (info?.nicknames?.[botID] !== botNickname) {
        await botAPI.changeNickname(botNickname, thread.threadID, botID);
        emitLog(`Bot nickname set in ${thread.threadID}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (e) {
    emitLog('Nickname set error: ' + e.message, true);
  }
}

// === THREAD NAME LOCK ===
async function handleThreadNameChange(api, event) {
  const { threadID, authorID } = event;
  const newTitle = event.logMessageData?.name;
  if (lockedGroups[threadID] && authorID !== adminID && newTitle !== lockedGroups[threadID]) {
    await api.setTitle(lockedGroups[threadID], threadID);
    const user = await api.getUserInfo(authorID).catch(() => ({}));
    const name = user?.[authorID]?.name || 'User';
    await api.sendMessage({ body: `@${name} group name locked!`, mentions: [{ tag: name, id: authorID }] }, threadID);
  }
}

// === NICKNAME LOCK ===
async function handleNicknameChange(api, event) {
  const { threadID, authorID, participantID, newNickname } = event;
  const botID = api.getCurrentUserID();
  if (participantID === botID && authorID !== adminID && newNickname !== botNickname) {
    await api.changeNickname(botNickname, threadID, botID);
  }
  if (lockedNicknames[threadID] && authorID !== adminID && newNickname !== lockedNicknames[threadID]) {
    await api.changeNickname(lockedNicknames[threadID], threadID, participantID);
  }
}

// === BOT ADDED ===
async function handleBotAddedToGroup(api, event) {
  const { threadID, logMessa

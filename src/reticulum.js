import EventEmitter from 'node:events';
import WebSocket from 'ws';
import https from 'https';
import * as phoenix from "phoenix";
import { config as dotenv_config } from 'dotenv';
dotenv_config({ path: ".env" });
dotenv_config({ path: ".env.defaults" });

// Converts a Phoenix message push object into a promise that resolves when the push
// is acknowledged by Reticulum or rejects when it times out or Reticulum produces an error.
function promisifyPush(push) {
  return new Promise((resolve, reject) => {
    return push
      .receive("ok", resolve)
      .receive("timeout", reject)
      .receive("error", reject);
  });
}

function isDiscordBot(presenceMetadata) {
  return presenceMetadata.context && presenceMetadata.context.discord;
}

// State related to a single Hubs Phoenix channel subscription.
export class ReticulumChannel extends EventEmitter {

  constructor(channel) {
    super();
    this.channel = channel;
    this.presence = new phoenix.Presence(channel);
  }

  async connect() {

    this.presence.onJoin((id, curr, p) => {
      const mostRecent = p.metas[p.metas.length - 1];

      if (isDiscordBot(mostRecent)) {
        return;
      }

      if (curr != null && curr.metas != null && curr.metas.length > 0) {
        // this user was already in the lobby or room, notify iff their name changed or they moved between the lobby and room
        const previous = curr.metas[curr.metas.length - 1];
        if (previous.profile && mostRecent.profile && previous.profile.displayName !== mostRecent.profile.displayName) {
          this.emit('renameuser', Date.now(), id, mostRecent.presence, previous.profile.displayName, mostRecent.profile.displayName);
        }
        if (previous.presence === "lobby" && mostRecent.presence && previous.presence !== mostRecent.presence) {
          this.emit('moved', Date.now(), id, mostRecent.presence, previous.presence);
        }
        return;
      }

      // this user was not previously present, notify for a join
      let name = mostRecent.profile.displayName;
      if (mostRecent.profile.identityName) {
        name = `${name} (${mostRecent.profile.identityName})`;
      }
      this.emit('join', Date.now(), id, mostRecent.presence, name);
    });

    this.presence.onLeave((id, curr, p) => {
      const mostRecent = p.metas[p.metas.length - 1];

      if (isDiscordBot(mostRecent)) {
        return;
      }

      if (curr != null && curr.metas != null && curr.metas.length > 0) {
        return; // this user is still in the lobby or room, don't notify yet
      }

      let name = mostRecent.profile.displayName;
      if (mostRecent.profile.identityName) {
        name = `${name} (${mostRecent.profile.identityName})`;
      }
      this.emit('leave', Date.now(), id, mostRecent.presence, name);
    });

    this.presence.onSync(() => { this.emit('sync', Date.now()); });

    this.channel.on("hub_refresh", ({ session_id, stale_fields, hubs }) => {
      const sender = this.getName(session_id);
      if (stale_fields.includes('scene')) {
        this.emit('rescene', Date.now(), session_id, sender, hubs[0].scene);
      }
      if (stale_fields.includes('name')) { // for some reason it doesn't say that the slug is stale, but it is
        this.emit('renamehub', Date.now(), session_id, sender, hubs[0].name, hubs[0].slug);
      }
    });

    this.channel.on("pin", (data) => {
      const { gltf_node, pinned_by } = data;
      if (gltf_node &&
          gltf_node.extensions &&
          gltf_node.extensions.HUBS_components &&
          gltf_node.extensions.HUBS_components.media &&
          gltf_node.extensions.HUBS_components.media.src) {
        const sender = this.getName(pinned_by);
        this.emit('message', Date.now(), null, sender, "media", { src: gltf_node.extensions.HUBS_components.media.src });
      }
    });

    this.channel.on("message", ({ session_id, type, body, from, discord }) => {
      if (discord) {
        return;
      }

      const sender = from || this.getName(session_id);
      this.emit('message', Date.now(), session_id, sender, type, body);
    });

    const data = await new Promise((resolve, reject) => {
      this.channel.join()
        .receive("error", reject)
        .receive("timeout", reject)
        .receive("ok", data => { // this "ok" handler will be called on reconnects as well

          this.emit('connect', Date.now(), data.session_id);

          resolve(data);
        });
    });

    return data;
  }

  async close() {
    return promisifyPush(this.channel.leave());
  }

  // Returns the most recent display name of the given session ID in presence.
  getName(sessionId) {
    const userInfo = this.presence.state[sessionId];
    if (userInfo) {
      const mostRecent = userInfo.metas[userInfo.metas.length - 1];
      return mostRecent.profile.displayName;
    }
    return null;
  }

  // Returns presence info for all users in the room, except ourselves.
  getUsers() {
    const result = {};
    for (const id in this.presence.state) {
      const state = this.presence.state[id];
      const mostRecentMeta = state.metas[state.metas.length - 1];

      if (!isDiscordBot(mostRecentMeta)) {
        result[id] = state;
      }
    }
    return result;
  }

  // Returns the number of users in the room, except ourselves.
  getUserCount() {
    let result = 0;
    for (const id in this.presence.state) {
      const state = this.presence.state[id];
      const mostRecentMeta = state.metas[state.metas.length - 1];

      if (!isDiscordBot(mostRecentMeta)) {
        result++;
      }
    }
    return result;
  }

  // Sends a chat message that Hubs users will see in the chat box.
  sendMessage(name, kind, body) {
    this.channel.push("message", { type: kind, from: name, body, discord: true }); // no ack is expected
  }

  // Updates our profile metadata in presence.
  updateProfile(profile) {
    this.channel.push("events:profile_updated", { profile }); // no ack is expected
  }
}

// State related to the Phoenix connection to Reticulum, independent of any particular Phoenix channel.
export class ReticulumClient {

  constructor(hostname, logger) {
    this.hostname = hostname;
    this.socket = new phoenix.Socket(`wss://${hostname}/socket`, {
      transport: WebSocket,
      logger
    });
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.socket.onOpen(resolve);
      this.socket.onError(reject);
      this.socket.connect();
    });
  }

  async _request(method, path, payload) {
    const endpoint = `https://${this.hostname}/api/v1/${path}`;
    const payloadJson = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "x-ret-bot-access-key": process.env.RETICULUM_BOT_ACCESS_KEY,
      "content-length": Buffer.byteLength(payloadJson)
    };

    return new Promise((resolve, reject) => {
      const req = https.request(endpoint, { method, headers }, res => {
        let json = "";
        res.on("data", chunk => json += chunk);
        res.on("end", () => {
          let result;
          try {
            result = JSON.parse(json);
          } catch(e) {
            // ignore json parsing errors
          }
          resolve(result);
        });
      });
      req.on("error", reject);
      req.end(payloadJson);
    });
  }

  // Creates a new hub with the given name and scene.
  async createHubFromScene(name, sceneId) {
    const payload = { hub: { name, scene_id: sceneId } };
    return this._request("POST", "hubs", payload);
  }

  // Creates a new hub with the given name and GLTF/GLB/bundle URL.
  async createHubFromUrl(name, url) {
    const payload = { hub: { name, default_environment_gltf_bundle_url: url } };
    return this._request("POST", "hubs", payload);
  }

  bindHub(hubId, guildId, channelId) {
    const payload = {
      hub_binding: {
        hub_id: hubId,
        type: "discord",
        community_id: guildId,
        channel_id: channelId
      }
    };
    return this._request("POST", "hub_bindings", payload);
  }

  // Returns a channel object for the given Hub room's Phoenix channel.
  channelForHub(hubId, profile) {
    const payload = {
      profile: profile,
      context: { mobile: false, hmd: false, discord: true },
      bot_access_key: process.env.RETICULUM_BOT_ACCESS_KEY
    };
    return new ReticulumChannel(this.socket.channel(`hub:${hubId}`, payload));
  }

}

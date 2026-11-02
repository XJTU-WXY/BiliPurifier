// 云端同步管理器
class SyncManager {
  constructor() {
    this.syncEnabled = true;
    this.lastSyncTime = 0;
    this.syncInProgress = false;
    this.writeChain = Promise.resolve();
    this.SYNC_LIMIT = 8192;
  }

  // 生成设置数据的版本信息
  createVersionedData(data) {
    return {
      ...data,
      version: Date.now(),
      deviceId: this.getDeviceId()
    };
  }

  // 获取设备标识
  getDeviceId() {
    let deviceId = localStorage.getItem('bilipurifier_device_id');
    if (!deviceId) {
      deviceId = 'device_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
      localStorage.setItem('bilipurifier_device_id', deviceId);
    }
    return deviceId;
  }

  // 保存设置到本地和云端。写入串行执行，避免并发保存互相覆盖
  saveSettings(settings) {
    this.writeChain = this.writeChain.then(
      () => this._saveSettings(settings),
      () => this._saveSettings(settings)
    );
    return this.writeChain;
  }

  async _saveSettings(settings) {
    const versionedData = this.createVersionedData(settings);
    await new Promise((resolve, reject) => {
      chrome.storage.local.set(versionedData, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
    if (this.syncEnabled) {
      await this.syncToCloud(versionedData);
    }
    return versionedData;
  }

  // 同步到云端，超出单项上限时跳过
  async syncToCloud(data) {
    try {
      const dataSize = JSON.stringify(data).length;
      if (dataSize > this.SYNC_LIMIT) {
        console.warn('规则体积 ' + dataSize + ' 字节，超出云端单项上限，已跳过同步');
        return false;
      }
      await new Promise((resolve, reject) => {
        chrome.storage.sync.set({ bilipurifier_settings: data }, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        });
      });
      this.lastSyncTime = Date.now();
      return true;
    } catch (error) {
      console.error('云端同步失败:', error);
      return false;
    }
  }

  // 从云端和本地加载设置，选择最新的版本
  async loadSettings() {
    if (this.syncInProgress) {
      return this.loadLocalSettings();
    }

    this.syncInProgress = true;

    try {
      const [localData, cloudData] = await Promise.all([
        this.loadLocalSettings(),
        this.loadCloudSettings()
      ]);

      const finalSettings = this.mergeSettings(localData, cloudData);

      if (cloudData && cloudData.version > (localData.version || 0)) {
        await new Promise((resolve, reject) => {
          chrome.storage.local.set(finalSettings, () => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve();
          });
        });
      } else if (localData && localData.version > ((cloudData && cloudData.version) || 0)) {
        await this.syncToCloud(finalSettings);
      }

      return finalSettings;
    } catch (error) {
      console.error('加载设置失败:', error);
      return this.loadLocalSettings();
    } finally {
      this.syncInProgress = false;
    }
  }

  // 读取本地全部设置项
  async loadLocalSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (data) => resolve(data || {}));
    });
  }

  // 加载云端设置
  async loadCloudSettings() {
    try {
      return new Promise((resolve, reject) => {
        chrome.storage.sync.get(['bilipurifier_settings'], (data) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(data.bilipurifier_settings || null);
        });
      });
    } catch (error) {
      console.error('加载云端设置失败:', error);
      return null;
    }
  }

  // 合并本地和云端设置，选择最新版本
  mergeSettings(localData, cloudData) {
    if (!localData && !cloudData) return {};
    if (!localData) return cloudData;
    if (!cloudData) return localData;

    const localVersion = localData.version || 0;
    const cloudVersion = cloudData.version || 0;

    return cloudVersion > localVersion ? cloudData : localData;
  }

  // 启用/禁用同步
  setSyncEnabled(enabled) {
    this.syncEnabled = enabled;
    return new Promise((resolve) => {
      chrome.storage.local.set({ syncEnabled: enabled }, resolve);
    });
  }

  // 获取同步状态
  async getSyncEnabled() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['syncEnabled'], (data) => {
        this.syncEnabled = data.syncEnabled !== false;
        resolve(this.syncEnabled);
      });
    });
  }

  // 手动触发同步
  async manualSync() {
    const settings = await this.loadSettings();
    return settings;
  }

  // 清除云端数据
  async clearCloudData() {
    await new Promise((resolve, reject) => {
      chrome.storage.sync.remove(['bilipurifier_settings'], () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
  }

  // 获取同步状态信息
  async getSyncStatus() {
    try {
      const [localData, cloudData] = await Promise.all([
        this.loadLocalSettings(),
        this.loadCloudSettings()
      ]);

      return {
        syncEnabled: this.syncEnabled,
        hasLocalData: !!localData && Object.keys(localData).length > 0,
        hasCloudData: !!cloudData && Object.keys(cloudData).length > 0,
        localVersion: (localData && localData.version) || 0,
        cloudVersion: (cloudData && cloudData.version) || 0,
        lastSyncTime: this.lastSyncTime,
        deviceId: this.getDeviceId(),
        payloadSize: JSON.stringify({ ...localData, version: 0, deviceId: '' }).length,
        payloadLimit: this.SYNC_LIMIT
      };
    } catch (error) {
      console.error('获取同步状态失败:', error);
      return {
        syncEnabled: false,
        hasLocalData: false,
        hasCloudData: false,
        localVersion: 0,
        cloudVersion: 0,
        lastSyncTime: 0,
        deviceId: this.getDeviceId(),
        payloadSize: 0,
        payloadLimit: this.SYNC_LIMIT
      };
    }
  }
}

window.syncManager = new SyncManager();

let updateInstallQuitRequested = false;

export const markUpdateInstallQuitRequested = (): void => {
  updateInstallQuitRequested = true;
};

export const clearUpdateInstallQuitRequested = (): void => {
  updateInstallQuitRequested = false;
};

export const isUpdateInstallQuitRequested = (): boolean => updateInstallQuitRequested;

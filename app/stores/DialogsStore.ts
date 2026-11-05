import { action, makeObservable, observable } from "mobx";
import { v4 as uuidv4 } from "uuid";
import * as React from "react";

type DialogDefinition = {
  title: React.ReactNode;
  content: React.ReactNode;
  isOpen: boolean;
  style?: React.CSSProperties;
  width?: number | string;
  height?: number | string;
  onClose?: () => void;
};

type GuideDefinition = {
  title: string;
  content: React.ReactNode;
  isOpen: boolean;
};

export default class DialogsStore {
  @observable.shallow
  guide: GuideDefinition | undefined = undefined;

  @observable.shallow
  modalStack = new Map<string, DialogDefinition>();

  constructor() {
    makeObservable(this);
  }

  openGuide = ({
    title,
    content,
  }: {
    title: string;
    content: React.ReactNode;
  }) => {
    setTimeout(
      action(() => {
        this.guide = {
          title,
          content,
          isOpen: true,
        };
      }),
      0
    );
  };

  @action
  closeGuide = () => {
    if (this.guide) {
      this.guide.isOpen = false;
    }
  };

  openModal = ({
    id,
    title,
    content,
    replace,
    style,
    width,
    height,
    onClose,
  }: Omit<DialogDefinition, "isOpen"> & {
    id?: string;
    replace?: boolean;
  }) => {
    setTimeout(
      action(() => {
        let replaceId;
        if (replace) {
          replaceId = Array.from(this.modalStack.keys())[0];
          this.modalStack.clear();
        }

        const nextStack = new Map(this.modalStack);
        nextStack.set(id ?? replaceId ?? uuidv4(), {
          title,
          content,
          style,
          width,
          height,
          isOpen: true,
          onClose,
        });
        this.modalStack = nextStack;
      }),
      0
    );
  };

  @action
  closeModal = (id: string) => {
    const nextStack = new Map(this.modalStack);
    nextStack.delete(id);
    this.modalStack = nextStack;
  };

  @action
  closeAllModals = () => {
    this.modalStack = new Map();
  };
}

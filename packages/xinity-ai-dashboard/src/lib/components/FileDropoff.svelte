<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import UploadIcon from "./icons/UploadIcon.svelte";

  export let inputProps: object = { multiple: true };
  export let disabled: boolean = false;
  export let accept = "*";

  type LocatedFile = { file: File; path: string };

  let files: FileList | null;
  let fileDropArea: HTMLElement;
  let fileInput: HTMLElement;

  const dispatch = createEventDispatcher<{ uploaded: LocatedFile[] }>();

  async function scanDataTransfer(dataTransfer: DataTransfer): Promise<LocatedFile[]> {
    const entries = Array.from(dataTransfer.items).map((item) => item.webkitGetAsEntry());
    const files = await Promise.all(entries.map((e) => (e ? scanFilesystemEntry(e) : null)));
    return files.flat().filter(Boolean) as LocatedFile[];
  }
  async function scanFilesystemEntry(entry: FileSystemEntry): Promise<LocatedFile[]> {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file: File = await new Promise((resolve, reject) => fileEntry.file(resolve, reject));
      return [
        {
          file,
          // Removing leading slash
          path: fileEntry.fullPath.substring(1),
        },
      ];
    }

    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      (entry as FileSystemDirectoryEntry).createReader().readEntries(resolve, reject),
    );
    return Promise.all(entries.map(async (entry) => scanFilesystemEntry(entry))).then((files) =>
      files.flat(),
    );
  }

  $: {
    if (files && files.length) {
      dispatch(
        "uploaded",
        Array.from(files).map((file) => ({ file, path: file.webkitRelativePath })),
      );
      files = null;
    }
  }
</script>

<div class="flex flex-col justify-center w-full gap-4">
  <button
    bind:this={fileDropArea}
    on:click={() => fileInput.click()}
    on:dragover={(e) => {
      e.preventDefault();
      if (!disabled) {
        fileDropArea.classList.add("border-xinity-purple", "bg-xinity-purple/10");
      }
    }}
    on:dragleave={() => {
      fileDropArea.classList.remove("border-xinity-purple", "bg-xinity-purple/10");
    }}
    on:drop={async (e) => {
      e.preventDefault();
      fileDropArea.classList.remove("border-xinity-purple", "bg-xinity-purple/10");

      if (e.dataTransfer && !disabled) {
        // files = e.dataTransfer.files;
        dispatch("uploaded", await scanDataTransfer(e.dataTransfer));
      }
    }}
    class:hover:border-xinity-purple={!disabled}
    class="flex flex-col items-center justify-center w-full max-w-md p-6 px-20 transition-colors bg-white border-2 border-dashed rounded-lg cursor-pointer border-grey-100 md:max-w-lg">
    <UploadIcon />

    <p class="mt-2 mb-3 font-sans text-xl font-semibold text-xinity-magenta hover:text-xinity-pink">
      <slot name="message">Drag & Drop files, or select them</slot>
    </p>
    <input
      {accept}
      bind:this={fileInput}
      bind:files
      {disabled}
      type="file"
      class="hidden"
      {...inputProps} />
  </button>

  <slot />
</div>

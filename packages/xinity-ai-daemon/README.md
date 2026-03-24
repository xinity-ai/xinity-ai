# Xinity AI Daemon

A utility serivce to set up connected drivers, to run the raw model inference.

### Project init
```bash
bun install
bun run dev
```

### Extra Init
If you have direnv installed, set up a `.envrc` file for yourself, and populate it with `use flake .` to automatically load the devshell included in this flake.


### Node Preparation
#### Drivers
To ensure the ai node being prepared has the required capabilities, ensure that ollama is installed. It functions as the default driver, and is implicitly assumed to be present on all ai nodes (at least at this point).

The installation can be started like this:  
```bash
curl -fsSL https://ollama.com/install.sh | sh
systemctl edit ollama
```
Enter the following in the service override that opened due to `syst4emctl edit ollama`
```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
```

```bash
systemctl restart ollama
```



## Deployments

Deployments are made possible via inclusion of this flake in any nixos configuration project. The required steps then are to add it as an input, to import the nixosModule.default into the system modules, and to set the required configuration values, i.e.

```nix
{
  services.xinity-ai-node = {
    enable = true;
    envFile = "/root/.env";
    ...
  };
}
```
For exact options check `config.nix`


## Testing

Testing is done largely manually. You can create a development contianer in which to try the building the configuration, running the service, and seeing if everything works as expected. Here are relevant commands for this:

```bash
# to create a new container
nixos-container create "xinity-ai-daemon-tester" --flake .#container
nixos-container start "xinity-ai-daemon-tester"
# to enter the container, and test interactively
nixos-container root-login "xinity-ai-daemon-tester" 
# to stop and remove the container
nixos-container stop "xinity-ai-daemon-tester"; 
nixos-container destroy "xinity-ai-daemon-tester"
```
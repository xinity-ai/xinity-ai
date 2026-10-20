# Serving Across Coupled Nodes

A model too large for one machine can be served by several [coupled](node-coupling.md) machines together. Each machine holds a part of the model, and together they serve it as one replica. Two DGX Spark machines on their ConnectX cable are the typical example.

Nothing has to be turned on. Once the machines are coupled and can run a part of a model, the scheduler uses them whenever a deployment needs it.

## What the Machines Need

- **A working coupling.** Set up the link as described in [Setting Up the Link](node-coupling.md#setting-up-the-link), including trusting the coupled interfaces in the host firewall. Both ends need an IPv4 subnet in common.
- **Room in the coupling subnet.** Each machine serving a part of a model gets an extra address in each subnet of its coupling, taken from the top of the subnet. Assign the port addresses from the bottom, as in the examples, and leave a free address for every part a machine may serve. The `/24` subnets of the examples have plenty.
- **RDMA devices**, which the card's driver provides. With the Docker backend, Docker must run as root, since rootless Docker cannot give a container its own address on the coupling.

The Compute page shows each machine's couplings. A machine that cannot serve a part of a model is left out of placement and keeps serving models of its own.

## How Placement Decides

The **Optimize for** setting of a deployment decides when a replica spans machines:

- **Space** keeps a replica on one machine whenever the model fits there, and spans coupled machines only when it does not.
- **Speed** spans coupled machines whenever that gives the replica more cards to work with.

Machines are only combined across a coupling, and each is charged its own part of the model, so the machines of one replica can differ. While creating or editing a deployment, the capacity summary lists every machine a replica would use and what it takes on each. When a model fits nowhere, it shows what each machine would need and how much it has free.

## Starting a Replica

The first machine of a replica downloads the model. The others copy each file from it over the coupling as soon as that file is complete, so the model is downloaded from HuggingFace only once. While a machine copies, its status reads *Copying from* followed by the first machine's name. If a copy is not possible, that machine downloads the file from HuggingFace itself.

The machines start the model together, once every one of them has the model and the memory for its part.

## What a Replica Shows

On the deployment, a replica served across machines counts as one replica. It is named after its first machine and lists each machine with its state, cards and memory. Requests for the model go to the first machine, and its usage is counted there.

A replica is ready only when every machine is. When one machine fails, the replica has failed, even while the others still run. When the coupling under a replica degrades or comes apart, the deployment shows a warning that names the problem.

## Failures and Restarts

When one machine of a replica fails, all of its machines stop and the replica starts again as a whole. A coupled port that loses its link, such as a pulled cable, counts as a failure within about half a minute. After three attempts, the replica stays failed. **Retry** on the deployment then replaces the failed replica on all of its machines.

Removing or disabling a deployment stops the replica on every machine.

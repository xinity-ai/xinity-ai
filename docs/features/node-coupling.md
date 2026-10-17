# Node Coupling

Nodes joined by a fast RDMA-capable network link, either a direct cable or a switch, are **coupled**. Xinity detects couplings on its own, shows them on the dashboard, and checks that the link works. Two DGX Spark machines connected by their ConnectX cable are the typical example.

Detection needs nothing beyond the daemon on each node and a correctly set up link. A node without such a link behaves exactly as before.

## Setting Up the Link

Xinity never configures network ports itself, since the host's network tools would undo it. Configure the cabled ports with the machine's own tools:

1. **Give each cabled interface a static IPv4 address**, with both ends in the same subnet. Some cards expose one physical port as two interfaces (DGX Spark does). Configure both, each in its own subnet.
2. **Keep the IPv6 link-local address enabled** on those interfaces. Xinity uses it to find the machine on the other end.
3. **Set the MTU to 9000** on every coupled interface, and on the switch if there is one. Both ends must use the same value.
4. **Trust the coupled interfaces in the host firewall.** A model served across the coupled nodes sets up its connections over TCP on ports that change from start to start, so opening single ports is not enough. The link test in `xinity stack doctor` uses TCP port 18515. RDMA traffic itself is not affected by host firewalls.
5. **Install `rdma-core`** on each node, so `xinity stack doctor` can test the link.

With NetworkManager, for a DGX Spark whose cable sits in the first port (run on the second machine with `.2` instead of `.1`):

```bash
nmcli con add type ethernet ifname enp1s0f0np0 con-name coupling-a \
  ipv4.method manual ipv4.addresses 192.168.100.1/24 ipv6.method link-local 802-3-ethernet.mtu 9000
nmcli con add type ethernet ifname enP2p1s0f0np0 con-name coupling-b \
  ipv4.method manual ipv4.addresses 192.168.101.1/24 ipv6.method link-local 802-3-ethernet.mtu 9000
```

Without a profile like this, NetworkManager repeatedly takes the port over and removes its addresses, which breaks any connection running across the link.

To trust the coupled interfaces, with the same interface names:

```bash
# ufw
sudo ufw allow in on enp1s0f0np0
sudo ufw allow in on enP2p1s0f0np0

# firewalld
sudo firewall-cmd --permanent --zone=trusted --add-interface=enp1s0f0np0 --add-interface=enP2p1s0f0np0
sudo firewall-cmd --reload
```

On NixOS:

```nix
networking.firewall.trustedInterfaces = [ "enp1s0f0np0" "enP2p1s0f0np0" ];
```

Changes to the link show up within about 30 seconds.

With a working coupling, a model too large for one machine can be served across the coupled machines, see [Serving Across Coupled Nodes](serving-across-nodes.md).

## Where Couplings Show

- **Dashboard:** the [Compute page](dashboard.md#compute-dashboard) lists, on each machine card, which machines it is coupled with and any problem with its link.
- **CLI:** `xinity stack doctor` lists the couplings across the stack's hosts and sends real RDMA traffic over every link that looks usable. Link problems are warnings. A link that looks usable but fails the RDMA test is an error and makes the doctor exit with a failure.

Ports without a cable are ignored everywhere.

## Troubleshooting

Each message on the dashboard and in `xinity stack doctor` links to its entry here.

### No IPv4 address

*interface* has no IPv4 address

Assign a static IPv4 address to the interface, in the same subnet as the other end of the cable. A profile like the one [above](#setting-up-the-link) keeps it in place.

### Address RDMA cannot use

*interface* has an address RDMA cannot use

Check that the address sits on the cabled interface itself and not on a bridge or bond on top of it, and that the card's RDMA driver is loaded.

### Address keeps vanishing

*interface* lost its address *n* times since the daemon started

A network tool keeps taking the port over and removes its address. Give the interface a profile of its own, like the one [above](#setting-up-the-link).

### MTU below 9000

*interface* runs at MTU *n*, RDMA needs 9000 for full speed

The link works, but slower than it could. Set the MTU to 9000 on every coupled interface, and on the switch if there is one.

### No machine answers

cable in, but no machine answers on it

Check that the machine on the other end is powered on and that its interface keeps an IPv6 link-local address. Without a profile of its own, a network tool may keep removing it. When the other machine reports this too, fix its interface first.

### Machine without the Xinity daemon

a machine without the Xinity daemon answers

Install the daemon on that machine, or ignore the message if the machine is not meant to be coupled.

### Different MTUs

coupled ports use different MTUs

Use the same MTU on all ends, including the switch.

### Different speeds

coupled ports link at different speeds

Check the cables and switch ports. The link runs at the slower speed.

### No common subnet

coupled ports have no IPv4 subnet in common

Put the addresses at both ends of the cable into the same subnet.

### rdma-core missing

`ibv_rc_pingpong` not found

`xinity stack doctor` tests the link with `ibv_rc_pingpong`. Install `rdma-core` on each coupled node.

### Test connection blocked

could not reach *address* on TCP 18515

The link test starts with a TCP connection on port 18515. Trust the coupled interfaces in the host firewall, as shown in [Setting Up the Link](#setting-up-the-link). RDMA traffic itself is not affected by host firewalls.

### RDMA transfer failed

the RDMA transfer failed although the link looks usable

Check that the MTUs match at both ends and on the switch, then check the cable.

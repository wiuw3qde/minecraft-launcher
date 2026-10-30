import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;

public class UuidTest {
    public static void main(String[] args) throws Exception {
        for (String name : new String[] { "Notch", "Steve" }) {
            byte[] bytes = ("OfflinePlayer:" + name).getBytes(StandardCharsets.UTF_8);
            System.out.println(name + " = " + UUID.nameUUIDFromBytes(bytes).toString());
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] raw = md.digest(bytes);
            raw[6] &= 0x0f; raw[6] |= 0x30;
            raw[8] &= 0x3f; raw[8] |= 0x80;
            StringBuilder sb = new StringBuilder();
            for (byte b : raw) sb.append(String.format("%02x", b));
            System.out.println(name + " (手动)  = " + sb.toString());
        }
    }
}

import Login from "./Login";
import {
  Icon,
  MenuItem,
  Container,
  Menu,
  Typography,
  IconButton,
  Toolbar,
  Box,
  AppBar,
} from "@mui/material";
import { MouseEvent, MouseEventHandler, useContext, useState } from "react";
import Link from "./Link";
import { useSession } from "next-auth/react";
import { TranslateContext } from "../Modules/context";
interface MenuItemsInterface {
  league: undefined | number;
  handleCloseNavMenu: MouseEventHandler;
}
// Returns all the menu items
function MenuItems({ league, handleCloseNavMenu }: MenuItemsInterface) {
  const { data: session } = useSession();
  if (!league && session) {
    league = session.user.favoriteLeague
      ? session.user.favoriteLeague
      : undefined;
  }
  const t = useContext(TranslateContext);
  const pages = [{ name: t("Home"), link: "/" }];
  pages.push({ name: t("Download"), link: `/download` });
  // Checks if the player is logged in
  if (session || league) {
    if (session?.user.admin) {
      pages.push({ name: "Admin", link: "/admin" });
    }
    pages.push({ name: t("Leagues"), link: "/leagues" });
  }
  // Checks if the player should see the league links
  if (league) {
    pages.push({ name: t("Standings"), link: `/${league}` });
    pages.push({ name: t("Squad"), link: `/${league}/squad` });
    pages.push({ name: t("Transfers"), link: `/${league}/transfer` });
  }
  return (
    <>
      {pages.map((page) => (
        <Link styled={false} href={page.link} key={page.name}>
          <MenuItem onClick={handleCloseNavMenu}>
            <Typography textAlign="center">{page.name}</Typography>
          </MenuItem>
        </Link>
      ))}
    </>
  );
}
interface MainInterface {
  league?: number;
}
// Used to create a menu
const Layout = ({ league }: MainInterface) => {
  const [anchorElNav, setAnchorElNav] = useState<null | HTMLElement>(null);
  const handleOpenNavMenu = (event: MouseEvent<HTMLElement>) => {
    setAnchorElNav(event.currentTarget);
  };

  const handleCloseNavMenu = () => {
    setAnchorElNav(null);
  };

  return (
    <AppBar position="static">
      <Container maxWidth="xl">
        <Toolbar disableGutters>
          <Icon>sports_soccer</Icon>
          <Box sx={{ flexGrow: 1, display: { sm: "flex", md: "none" } }}>
            <IconButton
              size="large"
              onClick={handleOpenNavMenu}
              color="inherit"
            >
              <Icon>menu</Icon>
            </IconButton>
            <Menu
              id="menu-appbar"
              anchorEl={anchorElNav}
              anchorOrigin={{
                vertical: "bottom",
                horizontal: "left",
              }}
              keepMounted
              transformOrigin={{
                vertical: "top",
                horizontal: "left",
              }}
              open={Boolean(anchorElNav)}
              onClose={handleCloseNavMenu}
              sx={{
                display: { sm: "block", md: "none" },
              }}
            >
              <MenuItems
                league={league}
                handleCloseNavMenu={handleCloseNavMenu}
              />
            </Menu>
          </Box>
          <Box sx={{ flexGrow: 1, display: { xs: "none", md: "flex" } }}>
            <MenuItems
              league={league}
              handleCloseNavMenu={handleCloseNavMenu}
            />
          </Box>

          <Box sx={{ flexGrow: 0 }}>
            <Login />
          </Box>
        </Toolbar>
      </Container>
    </AppBar>
  );
};

export default Layout;
